"""Integration checks: `anywhere doctor` and the readiness reported by /health.

Each check talks to the real service with the configured credentials and
returns a `Check`. Missing configuration is reported as "not configured",
never raised. `/health` runs the cheap, read-only subset on a timer; the
doctor command adds the checks that spend a token or write an object.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import secrets
import shutil
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal

import httpx
import structlog

from . import budget
from .brev import BrevCLI, BrevError
from .config import ProvisioningMode, Settings
from .photon import PhotonClient, PhotonError
from .stdb import SpacetimeClient

log = structlog.get_logger()

Status = Literal["ok", "warn", "fail", "not configured", "info"]

#: Integration keys reported by /health (and mirrored to the platform row).
INTEGRATIONS = ("spacetime", "nemotron", "brev", "storage", "photon")


@dataclass
class Check:
    key: str
    name: str
    status: Status
    detail: str

    @property
    def failed(self) -> bool:
        return self.status == "fail"


def _err(exc: BaseException) -> str:
    text = str(exc).strip().splitlines()[0] if str(exc).strip() else exc.__class__.__name__
    return text[:240]


# ── SpacetimeDB ─────────────────────────────────────────────────────────────


def _token_identity(token: str) -> str | None:
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload)).get("hex_identity")
    except (IndexError, ValueError):
        return None


async def check_spacetime(s: Settings, *, count: bool = True) -> Check:
    """`count=False` (the background readiness probe) skips reading every workload
    just to report how many there are; the worker-only reducer probe alone proves
    the database is reachable and the identity is allowlisted."""
    name = "SpacetimeDB worker"
    if not s.spacetime_worker_token:
        return Check("spacetime", name, "not configured", "set SPACETIME_WORKER_TOKEN (see README step 2)")
    token = s.spacetime_worker_token.get_secret_value()
    client = SpacetimeClient(s.spacetime_host, s.spacetime_database, token, timeout=10)
    try:
        workloads = await client.sql("SELECT * FROM worker_workloads") if count else None
        # A harmless worker-only reducer: workers get "Workload not found",
        # anyone else "reserved for Anywhere services". Nothing is written.
        try:
            await client.call("add_event", 0, "info", "doctor probe", retries=1)
            allowlisted = True  # only if a workload 0 existed; still proves worker access
        except Exception as exc:
            text = str(exc)
            if "reserved for Anywhere services" in text:
                allowlisted = False
            elif "Workload not found" in text:
                allowlisted = True
            else:
                raise
    except Exception as exc:
        return Check("spacetime", name, "fail", f"{s.spacetime_host} ({s.spacetime_database}): {_err(exc)}")
    finally:
        await client.close()
    ident = _token_identity(token) or "unknown"
    short = f"0x{ident[:12]}…"
    if not allowlisted:
        return Check(
            "spacetime",
            name,
            "fail",
            f"reachable, but identity {short} is not in the worker table "
            f"(INSERT INTO worker (identity, label) VALUES (0x{ident}, 'control'))",
        )
    return Check(
        "spacetime",
        name,
        "ok",
        f"{s.spacetime_host}/{s.spacetime_database}: identity {short} is a worker"
        + (f"; {len(workloads)} workloads visible" if workloads is not None else ""),
    )


# ── NVIDIA ──────────────────────────────────────────────────────────────────


async def check_nvidia(s: Settings, *, live: bool) -> list[Check]:
    if not s.nvidia_api_key:
        return [Check("nemotron", "NVIDIA Nemotron", "not configured", "set NVIDIA_API_KEY (build.nvidia.com)")]
    headers = {"Authorization": f"Bearer {s.nvidia_api_key.get_secret_value()}", "Accept": "application/json"}
    base = s.nvidia_base_url.rstrip("/")
    checks: list[Check] = []
    async with httpx.AsyncClient(base_url=base, headers=headers, timeout=60) as http:
        try:
            res = await http.get("/models")
            res.raise_for_status()
            catalog = {m["id"] for m in res.json().get("data", [])}
        except Exception as exc:
            return [Check("nemotron", "NVIDIA API", "fail", f"{base}/models: {_err(exc)}")]
        for role, model in (("planner", s.planner_model), ("vision", s.vision_model)):
            label = f"Nemotron {role} model"
            if model not in catalog:
                checks.append(Check("nemotron", label, "fail", f"{model} is not in the {base} catalog"))
                continue
            if not live:
                checks.append(Check("nemotron", label, "ok", f"{model} listed (key not exercised)"))
                continue
            # One-token completion: proves the key and that this model is served to it.
            body = {"model": model, "messages": [{"role": "user", "content": "Reply with OK."}], "max_tokens": 1}
            try:
                r = await http.post("/chat/completions", json=body)
            except Exception as exc:
                checks.append(Check("nemotron", label, "fail", f"{model}: {_err(exc)}"))
                continue
            if r.status_code in (401, 403):
                checks.append(Check("nemotron", label, "fail", f"NVIDIA_API_KEY rejected ({r.status_code})"))
            elif r.status_code >= 300:
                checks.append(Check("nemotron", label, "fail", f"{model}: HTTP {r.status_code} {r.text[:160]}"))
            else:
                checks.append(Check("nemotron", label, "ok", f"{model} answered a 1-token request"))
    return checks


# ── Brev ────────────────────────────────────────────────────────────────────


async def check_brev(s: Settings, cli: BrevCLI | None = None) -> Check:
    """`cli` lets the readiness loop reuse the app's BrevCLI and its shared `brev ls` cache."""
    name = "NVIDIA Brev CLI"
    binary = shutil.which(s.brev_binary)
    if not binary:
        status: Status = "fail" if s.brev_api_key else "not configured"
        return Check("brev", name, status, f"'{s.brev_binary}' not found on PATH (the control image installs v0.6.337)")
    if not s.brev_api_key:
        return Check("brev", name, "not configured", f"{binary} installed; set BREV_API_KEY (an org API key, bak-…)")
    cli = cli or BrevCLI(binary, s.brev_api_key.get_secret_value(), s.provisioning_mode)
    try:
        count = await cli.check_auth()
    except BrevError as exc:
        return Check("brev", name, "fail", f"authentication failed: {_err(exc)}")
    return Check("brev", name, "ok", f"{binary}: BREV_API_KEY accepted; {count} instance(s) in the org")


# ── Object storage ──────────────────────────────────────────────────────────


async def check_storage(s: Settings, *, round_trip: bool, storage=None) -> Check:
    """`storage` lets the readiness loop reuse the app's client instead of building a
    boto3 client (synchronously, on the event loop) every refresh."""
    name = "Object storage (S3)"
    if not s.storage_ready:
        return Check("storage", name, "not configured", "set S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY")
    from .storage import Storage

    if storage is None:
        storage = await asyncio.to_thread(Storage, s)
    where = f"{s.s3_endpoint_url or 'AWS S3'} bucket {s.s3_bucket}"
    try:
        await asyncio.to_thread(storage.client.head_bucket, Bucket=storage.bucket)
    except Exception as exc:
        return Check("storage", name, "fail", f"{where}: head bucket failed: {_err(exc)}")
    if not round_trip:
        return Check("storage", name, "ok", f"{where} reachable")
    key = f"_doctor/{secrets.token_hex(8)}.txt"
    payload = secrets.token_hex(16).encode()
    try:
        async with httpx.AsyncClient(timeout=30) as http:
            put = await http.put(
                storage.presign_put(key, "text/plain"), content=payload, headers={"Content-Type": "text/plain"}
            )
            if put.status_code >= 300:
                return Check("storage", name, "fail", f"presigned PUT returned {put.status_code}: {put.text[:160]}")
            got = await http.get(storage.presign_get(key))
            if got.status_code >= 300 or got.content != payload:
                return Check("storage", name, "fail", f"presigned GET returned {got.status_code} or wrong bytes")
    except Exception as exc:
        return Check("storage", name, "fail", f"presign round trip failed: {_err(exc)}")
    finally:
        with contextlib.suppress(Exception):
            await asyncio.to_thread(storage.client.delete_object, Bucket=storage.bucket, Key=key)
    return Check(
        "storage",
        name,
        "ok",
        f"{where}: head bucket + presigned PUT/GET round trip OK "
        "(browser uploads also need a CORS rule allowing PUT from the web origin)",
    )


# ── Photon ──────────────────────────────────────────────────────────────────


async def check_photon(s: Settings) -> Check:
    name = "Photon Spectrum"
    if not s.photon_ready:
        return Check("photon", name, "not configured", "set SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET")
    try:
        project = await PhotonClient(s).get_project()
    except (PhotonError, httpx.HTTPError) as exc:
        return Check("photon", name, "fail", _err(exc))
    bridge = "" if s.messaging_bridge_secret else "; MESSAGING_BRIDGE_SECRET is unset, so the bridge can't call in"
    return Check("photon", name, "warn" if bridge else "ok", f"project '{project.get('name', '?')}' reachable{bridge}")


# ── Policy (informational) ──────────────────────────────────────────────────


def policy_checks(s: Settings) -> list[Check]:
    mode = s.provisioning_mode
    mode_detail = {
        ProvisioningMode.DISABLED: "disabled: plans are made but nothing is sent to Brev",
        ProvisioningMode.DRY_RUN: "dry_run: Brev credentials and instance types are checked; nothing is created",
        ProvisioningMode.LIVE: "live: approved plans create real, billed Brev instances",
    }[mode]
    return [
        Check("policy", "Provisioning mode", "warn" if mode == ProvisioningMode.LIVE else "info", mode_detail),
        Check(
            "policy",
            "Budget limits",
            "info",
            f"global {budget.usd(s.global_budget_cents)}, {s.max_concurrent_instances} concurrent instance(s), "
            f"{s.max_session_hours:g} h max session, desktops stop after {s.desktop_idle_minutes} idle min",
        ),
    ]


# ── Running ─────────────────────────────────────────────────────────────────


async def run_all(s: Settings, *, live: bool = True) -> list[Check]:
    """Every check. `live` spends one token per model and writes/deletes one object."""
    groups = await asyncio.gather(
        check_spacetime(s),
        check_nvidia(s, live=live),
        check_brev(s),
        check_storage(s, round_trip=live),
        check_photon(s),
    )
    checks: list[Check] = []
    for g in groups:
        checks.extend(g if isinstance(g, list) else [g])
    return checks + policy_checks(s)


MARKS: dict[str, str] = {"ok": "ok", "warn": "warn", "fail": "FAIL", "not configured": "--", "info": "info"}


def render(checks: list[Check]) -> str:
    width = max(len(c.name) for c in checks)
    lines = ["Anywhere doctor", ""]
    for c in checks:
        lines.append(f"  [{MARKS[c.status]:>4}] {c.name:<{width}}  {c.detail}")
    counts = {k: sum(1 for c in checks if c.status == k) for k in ("ok", "warn", "fail", "not configured")}
    lines += [
        "",
        f"{counts['ok']} ok, {counts['warn']} warning(s), {counts['fail']} failed, {counts['not configured']} not configured",
    ]
    return "\n".join(lines)


# ── Readiness for /health ───────────────────────────────────────────────────


@dataclass
class Readiness:
    """Cached results of the cheap, read-only checks, refreshed in the background."""

    settings: Settings
    interval: float = 300
    #: The app's shared clients, so background checks reuse caches and connections.
    brev: BrevCLI | None = None
    storage: object | None = None
    checks: dict[str, Check] = field(default_factory=dict)
    #: Failures seen by real calls (e.g. the planner model returning 404). The
    #: background probe only confirms a model is *listed*, so without this a model
    #: that is listed but not served shows green while every chat fails.
    observed: dict[str, Check] = field(default_factory=dict)
    checked_at: datetime | None = None
    _task: asyncio.Task | None = None
    _last: float = 0.0

    def configured(self) -> dict[str, bool]:
        s = self.settings
        out = s.integrations()
        out["brev"] = out["brev"] and shutil.which(s.brev_binary) is not None
        return out

    def integrations(self) -> dict[str, bool]:
        """Configured, and not failing its most recent live check."""
        configured = self.configured()
        return {
            k: configured[k]
            and not (k in self.checks and self.checks[k].failed)
            and not (k in self.observed and self.observed[k].failed)
            for k in INTEGRATIONS
        }

    def record_call(self, key: str, name: str, error: BaseException | None) -> None:
        """Feed the outcome of a real call into readiness (cleared by the next success)."""
        if error is None:
            self.observed.pop(key, None)
        else:
            self.observed[key] = Check(key, name, "fail", f"last call failed: {_err(error)}")

    def details(self) -> dict[str, dict]:
        configured = self.configured()
        out = {}
        for k in INTEGRATIONS:
            c = self.observed.get(k) or self.checks.get(k)
            out[k] = {
                "configured": configured[k],
                "status": c.status if c else ("pending" if configured[k] else "not configured"),
                "detail": c.detail if c else "",
            }
        return out

    async def refresh(self) -> None:
        s = self.settings
        probes: list[Callable[[], Awaitable[Check | list[Check]]]] = [
            lambda: check_spacetime(s, count=False),
            lambda: check_nvidia(s, live=False),
            lambda: check_brev(s, self.brev),
            lambda: check_storage(s, round_trip=False, storage=self.storage),
            lambda: check_photon(s),
        ]
        results = await asyncio.gather(*(p() for p in probes), return_exceptions=True)
        checks: dict[str, Check] = {}
        for key, r in zip(INTEGRATIONS, results, strict=True):
            if isinstance(r, BaseException):
                checks[key] = Check(key, key, "fail", _err(r))
            elif isinstance(r, list):
                worst = next((c for c in r if c.failed), r[0])
                checks[key] = worst
            else:
                checks[key] = r
        self.checks = checks
        self.checked_at = datetime.now(UTC)
        self._last = time.monotonic()

    async def _loop(self) -> None:
        while True:
            try:
                await self.refresh()
            except Exception as exc:  # pragma: no cover - defensive
                log.warning("readiness.refresh_failed", error=str(exc))
            await asyncio.sleep(self.interval)

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop(), name="readiness")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    def snapshot(self) -> dict:
        return {
            "integrations": self.integrations(),
            "checks": self.details(),
            "checked_at": self.checked_at.isoformat() if self.checked_at else None,
        }


__all__ = ["Check", "Readiness", "render", "run_all"]
