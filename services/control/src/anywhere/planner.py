"""Intent → validated compute plan.

Nemotron turns a request into a typed `Intent` (via tool calling). Everything
after that is deterministic: requirement sizing, machine selection, runtime
ranges and cost come from this module and the catalog, never from the model.
Where inputs are missing we widen ranges and lower confidence instead of
inventing precision.
"""

from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from .catalog import Catalog, Offer
from .render_bench import frame_minutes

WorkloadKind = Literal["desktop", "fine_tune", "training", "inference", "render"]
Application = Literal["blender", "vscode", "jupyter", "terminal", "unity", "unreal", "other"]
Preference = Literal["cheapest", "balanced", "fastest"]

#: Applications with a tested Linux desktop configuration.
SUPPORTED_APPS: dict[str, str] = {
    "blender": "Blender",
    "vscode": "VS Code",
    "jupyter": "JupyterLab",
    "terminal": "Terminal",
}

#: Minutes of billed time spent before useful work begins.
SETUP_MINUTES = {"desktop": 9, "batch": 6}
#: Installing Blender on a render machine and copying the project over.
RENDER_SETUP_MINUTES = 4


class Intent(BaseModel):
    """What the user wants, as understood by Nemotron. Untrusted input."""

    kind: WorkloadKind
    summary: str = Field(description="One sentence restating the user's goal in plain language.")
    application: Application | None = Field(None, description="Desktop application, if interactive.")
    model_params_billions: float | None = Field(
        None, description="Model size if the user named one, e.g. 7 for a 7B model."
    )
    dataset_size_mb: float | None = Field(None, description="Dataset size if known from an upload or the request.")
    epochs: int | None = Field(None, description="Training epochs if the user specified them.")
    session_hours: float | None = Field(
        None,
        description="How long the user will work on the desktop. Leave empty unless they said it; "
        "this is time at the machine, not how long a render takes.",
    )
    session_hours_stated: bool = Field(
        False, description="True only if the user explicitly said how long they need the machine."
    )
    scene_complexity: Literal["simple", "detailed", "heavy"] | None = Field(
        None,
        description="For Blender renders: simple (a few objects), detailed (dense props and textures), "
        "or heavy (interiors, volumetric fog, many lights).",
    )
    render_width: int | None = Field(None, description="Render width in pixels, if known (default 1920).")
    render_height: int | None = Field(None, description="Render height in pixels, if known (default 1080).")
    render_samples: int | None = Field(None, description="Cycles samples per pixel, if known (default 128).")
    render_frames: int | None = Field(None, description="Number of frames to render, for a render job (default 1).")
    preference: Preference | None = None
    max_budget_usd: float | None = None

    @field_validator("model_params_billions", "dataset_size_mb", "session_hours", "max_budget_usd")
    @classmethod
    def _non_negative(cls, v: float | None) -> float | None:
        if v is not None and (v < 0 or not math.isfinite(v)):
            raise ValueError("must be a finite, non-negative number")
        return v

    @field_validator("render_width", "render_height")
    @classmethod
    def _resolution(cls, v: int | None) -> int | None:
        if v is not None and not 16 <= v <= 16384:
            raise ValueError("resolution must be between 16 and 16384 pixels")
        return v

    @field_validator("render_samples")
    @classmethod
    def _samples(cls, v: int | None) -> int | None:
        if v is not None and not 1 <= v <= 65536:
            raise ValueError("samples must be between 1 and 65536")
        return v

    @field_validator("render_frames")
    @classmethod
    def _frames(cls, v: int | None) -> int | None:
        if v is not None and not 1 <= v <= 10000:
            raise ValueError("frames must be between 1 and 10000")
        return v

    @field_validator("epochs")
    @classmethod
    def _epochs(cls, v: int | None) -> int | None:
        if v is not None and not 1 <= v <= 20:
            raise ValueError("epochs must be between 1 and 20")
        return v


class Requirements(BaseModel):
    min_vram_gb: float
    min_ram_gb: float
    min_vcpus: int
    needs_stoppable: bool
    mode: Literal["interactive", "batch"]
    environment: str
    method: str | None = None
    rationale: list[str]


class Estimate(BaseModel):
    hours_low: float
    hours_high: float
    cost_low_cents: int
    cost_high_cents: int
    confidence: Literal["low", "medium", "high"]
    assumptions: list[str]


class Choice(BaseModel):
    offer: dict
    estimate: Estimate


class Plan(BaseModel):
    intent: Intent
    title: str
    requirements: Requirements
    selected: Choice
    alternatives: list[Choice]
    outputs: list[str]
    warnings: list[str]
    #: For Blender work: estimated minutes per frame on each candidate GPU (see render_bench).
    render_time: dict | None = None


class Unsupported(BaseModel):
    reason: str
    suggestion: str | None = None


# ── Sizing ──────────────────────────────────────────────────────────────────


def size(intent: Intent) -> Requirements | Unsupported:
    if intent.kind == "desktop":
        app = intent.application or "terminal"
        if app not in SUPPORTED_APPS:
            name = {"unity": "Unity", "unreal": "Unreal Engine"}.get(app, "That application")
            return Unsupported(
                reason=f"{name} isn't available yet. Anywhere desktops run Linux, and we only offer "
                "applications we have tested end to end.",
                suggestion="Blender, VS Code, JupyterLab and a full terminal are ready today.",
            )
        heavy = app == "blender"
        return Requirements(
            min_vram_gb=16 if heavy else 8,
            min_ram_gb=16 if heavy else 8,
            min_vcpus=4,
            needs_stoppable=True,
            mode="interactive",
            environment=f"{app}-desktop",
            rationale=[
                "Interactive work needs a persistent desktop you can return to.",
                "Only stoppable machines are eligible, so pausing keeps your disk.",
                *(
                    ["Blender's Cycles renderer uses the GPU through CUDA/OptiX; 16 GB keeps typical scenes in memory."]
                    if heavy
                    else []
                ),
            ],
        )

    if intent.kind in ("fine_tune", "training"):
        params = intent.model_params_billions
        if params is None:
            params = 0.5
            assumed = "No model size given; assuming a small (0.5B) base model."
        else:
            assumed = None
        if params > 34:
            return Unsupported(
                reason=f"A {params:g}B model needs multi-GPU training, which Anywhere doesn't run yet.",
                suggestion="Models up to ~34B can be fine-tuned with QLoRA on a single 48 GB GPU.",
            )
        if params <= 1.5:
            method, weights = "LoRA (16-bit)", params * 2 * 1.3
            vram = weights + 6
        else:
            method, weights = "QLoRA (4-bit)", params * 0.7
            vram = weights + 7
        rationale = [
            f"{method} keeps a {params:g}B model's weights at ~{_fmt_gb(weights)} "
            "plus room for activations and optimizer state.",
            "Batch jobs run unattended and the machine is released when they finish.",
        ]
        if params > 3:
            # Fits 16 GB on paper, but T4-class cards lack bf16 and leave no
            # headroom for 2k-token sequences; require a 24 GB Ampere-or-newer card.
            vram = max(vram, 17)
            rationale.append("Models above 3B need a bf16-capable 24 GB card for stable training.")
        if assumed:
            rationale.insert(0, assumed)
        return Requirements(
            min_vram_gb=_round_up_vram(vram),
            min_ram_gb=16,
            min_vcpus=4,
            needs_stoppable=False,
            mode="batch",
            environment="lora-sft",
            method=method,
            rationale=rationale,
        )

    if intent.kind == "inference":
        params = intent.model_params_billions or 1
        vram = params * 2 * 1.2 + 2
        if vram > 48:
            return Unsupported(reason=f"Serving a {params:g}B model at 16-bit needs more than one GPU.")
        return Requirements(
            min_vram_gb=_round_up_vram(vram),
            min_ram_gb=16,
            min_vcpus=4,
            needs_stoppable=False,
            mode="batch",
            environment="inference",
            rationale=[f"16-bit weights for {params:g}B parameters plus KV-cache headroom."],
        )

    # render
    return Requirements(
        min_vram_gb=16,
        min_ram_gb=16,
        min_vcpus=4,
        needs_stoppable=False,
        mode="batch",
        environment="blender-render",
        rationale=["Cycles renders on the GPU; 16 GB fits most production scenes."],
    )


def _round_up_vram(v: float) -> float:
    for tier in (8, 16, 24, 48):
        if v <= tier:
            return float(tier)
    return math.ceil(v)


def _fmt_gb(v: float) -> str:
    return f"{max(v, 0.5):.0f} GB" if v >= 1 else f"{v:.1f} GB"


# ── Runtime & cost ──────────────────────────────────────────────────────────


#: Heuristic QLoRA/LoRA throughput on an L4 (tokens/sec) by model size.
def _l4_tokens_per_sec(params_b: float) -> float:
    if params_b <= 0.6:
        return 6000
    if params_b <= 1.5:
        return 3200
    if params_b <= 4:
        return 1500
    if params_b <= 8:
        return 850
    if params_b <= 14:
        return 450
    return 200


def estimate(intent: Intent, req: Requirements, offer: Offer) -> Estimate:
    setup_h = (offer.boot_minutes + SETUP_MINUTES["desktop" if req.mode == "interactive" else "batch"]) / 60
    assumptions = [f"Includes ~{round(setup_h * 60)} min to boot and configure."]

    if req.mode == "interactive":
        confidence: Literal["low", "medium", "high"]
        if intent.session_hours and intent.session_hours_stated:
            low = high = intent.session_hours
            confidence = "high"
            assumptions.append(f"A {intent.session_hours:g} h session, as you asked.")
        elif intent.session_hours:
            # The agent's guess at how long the work might take: show it as a range from a
            # short first session, never as a confident commitment.
            low, high = 1.0, max(1.0, intent.session_hours)
            confidence = "low"
            assumptions.append(
                f"Priced as a 1 h session to start; Anywhere guessed the whole job could take up to "
                f"~{intent.session_hours:g} h of work at the machine."
            )
        else:
            low = high = 1.0
            confidence = "medium"
            assumptions.append("Priced as a 1 h session to start.")
        assumptions.append("Billed only while it runs: stop any time and resume later.")
        assumptions.append("Idle desktops are saved and stopped automatically.")
    elif req.environment == "blender-render":
        frames = intent.render_frames or 1
        fe = frame_minutes(
            offer.gpu_name,
            intent.scene_complexity or "detailed",
            intent.render_width or 1920,
            intent.render_height or 1080,
            intent.render_samples or 128,
        )
        if fe is None:
            low, high = 0.25, 2.0
            confidence = "low"
            assumptions.append(f"No benchmark data for the {offer.gpu_name}, so this is a wide guess.")
        else:
            low, high = frames * fe.minutes_low / 60, frames * fe.minutes_high / 60
            confidence = "medium" if fe.runs >= 3 else "low"
            assumptions.append(
                f"{frames} frame{'s' if frames != 1 else ''} at ~{fe.minutes_low:.1f}–{fe.minutes_high:.1f} min each on the "
                f"{fe.gpu}, from Blender Open Data benchmarks ({fe.runs} run{'s' if fe.runs != 1 else ''})."
            )
        assumptions.append(f"Includes ~{RENDER_SETUP_MINUTES} min to install Blender and copy your project.")
        low, high = low + RENDER_SETUP_MINUTES / 60, high + RENDER_SETUP_MINUTES / 60
        assumptions.append("The machine shuts down as soon as the last frame is saved.")
    elif req.environment == "lora-sft":
        params = intent.model_params_billions or 0.5
        epochs = intent.epochs or 2
        tps = _l4_tokens_per_sec(params) * offer.speed
        if intent.dataset_size_mb:
            tokens = intent.dataset_size_mb * 250_000 * epochs
            mid = tokens / tps / 3600
            low, high = mid * 0.6, mid * 1.8
            confidence = "medium"
            assumptions.append(
                f"~{intent.dataset_size_mb:g} MB of text ≈ {tokens / 1e6:.1f}M training tokens over {epochs} epochs."
            )
        else:
            low, high = 0.15, 1.5
            confidence = "low"
            assumptions.append("Dataset size unknown, so runtime is a wide range until it's uploaded.")
        assumptions.append("Throughput figures are planning heuristics, not benchmarks.")
    else:
        low, high = 0.25, 2.0
        confidence = "low"
        assumptions.append("Runtime depends heavily on inputs we haven't inspected yet.")

    low, high = low + setup_h, high + setup_h
    return Estimate(
        hours_low=round(low, 2),
        hours_high=round(high, 2),
        cost_low_cents=math.ceil(low * offer.price_per_hour * 100),
        cost_high_cents=math.ceil(high * offer.price_per_hour * 100),
        confidence=confidence,
        assumptions=assumptions,
    )


# ── Selection ───────────────────────────────────────────────────────────────


def eligible(req: Requirements, offers: list[Offer]) -> list[Offer]:
    return [
        o
        for o in offers
        if o.vram_gb >= req.min_vram_gb
        and o.ram_gb >= req.min_ram_gb
        and o.vcpus >= req.min_vcpus
        and (o.stoppable or not req.needs_stoppable)
        and (o.desktop_ready or req.mode != "interactive")
    ]


def rank(intent: Intent, req: Requirements, offers: list[Offer], preference: Preference) -> list[Choice]:
    scored = [(o, estimate(intent, req, o)) for o in offers]
    if not scored:
        return []
    max_cost = max(e.cost_high_cents for _, e in scored) or 1
    max_hours = max(e.hours_high for _, e in scored) or 1

    # Render estimates already come from per-GPU benchmarks, so a render's hours *are* its
    # speed; scaling them by the generic catalog speed factor would count speed twice.
    measured = req.environment == "blender-render"

    def speed(o: Offer) -> float:
        return 1.0 if measured else o.speed

    def key(item: tuple[Offer, Estimate]) -> tuple:
        o, e = item
        if preference == "cheapest":
            return (e.cost_high_cents, -o.speed)
        if preference == "fastest":
            return (e.hours_high, e.cost_high_cents) if measured else (-o.speed, e.cost_high_cents)
        # balanced: interactive work is billed by the hour regardless of GPU speed,
        # so weigh price more heavily there; batch weighs time and cost equally.
        w = 0.75 if req.mode == "interactive" else 0.5
        return (w * e.cost_high_cents / max_cost + (1 - w) * e.hours_high / max_hours / speed(o), o.type)

    # Collapse equivalent machines (same GPU/vCPU/RAM) to the cheapest provider.
    best: dict[tuple, tuple[Offer, Estimate]] = {}
    for o, e in scored:
        k = (o.gpu_name, o.gpu_count, o.vcpus, round(o.ram_gb / 4))
        if k not in best or o.price_per_hour < best[k][0].price_per_hour:
            best[k] = (o, e)
    ordered = sorted(best.values(), key=key)
    return [Choice(offer=o.public(), estimate=e) for o, e in ordered]


def plan(intent: Intent, catalog: Catalog, default_preference: Preference = "balanced") -> Plan | Unsupported:
    req = size(intent)
    if isinstance(req, Unsupported):
        return req
    candidates = eligible(req, catalog.offers())
    if not candidates:
        return Unsupported(
            reason=f"No machine in our catalog meets this workload's needs ({req.min_vram_gb:g} GB of GPU memory).",
        )
    preference = intent.preference or default_preference
    ranked = rank(intent, req, candidates, preference)
    warnings: list[str] = []

    if intent.max_budget_usd is not None:
        cap = math.floor(intent.max_budget_usd * 100)
        within = [c for c in ranked if c.estimate.cost_high_cents <= cap]
        if within:
            ranked = within + [c for c in ranked if c not in within]
        else:
            warnings.append(
                f"Every option may exceed your ${intent.max_budget_usd:g} budget at the high end of the estimate."
            )

    selected, *rest = ranked
    title = _title(intent)
    return Plan(
        intent=intent,
        title=title,
        requirements=req,
        selected=selected,
        alternatives=rest[:2],
        outputs=_outputs(intent, req),
        warnings=warnings,
        render_time=render_table(intent, [selected, *rest[:2]]) if _is_blender(intent) else None,
    )


def _is_blender(intent: Intent) -> bool:
    return intent.kind == "render" or (intent.kind == "desktop" and intent.application == "blender")


def render_table(intent: Intent, choices: list[Choice]) -> dict:
    """Estimated minutes per frame on each candidate GPU, for the plan card and the agent."""
    complexity = intent.scene_complexity or "detailed"
    width, height = intent.render_width or 1920, intent.render_height or 1080
    samples = intent.render_samples or 128
    rows: list[dict] = []
    for c in choices:
        fe = frame_minutes(c.offer["gpu"], complexity, width, height, samples)
        # One row per GPU: two machine sizes with the same GPU render at the same speed.
        if fe is not None and all(r["gpu"] != fe.gpu for r in rows):
            rows.append({**fe.public(), "type": c.offer["type"], "price_per_hour": c.offer["price_per_hour"]})
    return {
        "complexity": complexity,
        "width": width,
        "height": height,
        "samples": samples,
        "frames": intent.render_frames or 1,
        "rows": rows,
        "basis": "Blender Open Data, Blender 4.5 OptiX medians. A test render on the machine gives an exact number.",
    }


def _title(intent: Intent) -> str:
    if intent.kind == "desktop":
        return f"{SUPPORTED_APPS.get(intent.application or 'terminal', 'Linux')} desktop"
    if intent.kind == "fine_tune":
        size_ = f"{intent.model_params_billions:g}B " if intent.model_params_billions else ""
        return f"Fine-tune a {size_}language model"
    return {"training": "Training run", "inference": "Model inference", "render": "Render job"}[intent.kind]


def _outputs(intent: Intent, req: Requirements) -> list[str]:
    if req.mode == "interactive":
        return ["A live desktop in your browser", "Project files saved to your Anywhere storage"]
    if req.environment == "lora-sft":
        return ["LoRA adapter weights", "Training loss curve and logs", "Sample generations from the tuned model"]
    if req.environment == "blender-render":
        return ["Rendered frames", "Render logs"]
    return ["Outputs and logs saved to your Anywhere storage"]
