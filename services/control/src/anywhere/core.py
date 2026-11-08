"""Application services shared by the HTTP API, the agent's tools and the
messaging bridge. Every way of spending money funnels through `propose` and
`approve`, so validation and budget rules are applied identically everywhere."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime

import structlog

from . import budget, llm
from .brev import BrevCLI
from .catalog import Catalog
from .config import Settings
from .desktop import connect_screen
from .doctor import Readiness
from .ids import new_id
from .lifecycle import BILLABLE, Status
from .operator import build_operator
from .planner import Intent, Plan, Unsupported, plan
from .stdb import SpacetimeClient
from .storage import Storage
from .store import Store
from .supervisor import Supervisor
from .training import DatasetError, DatasetProfile, build_config
from .vault import Vault

log = structlog.get_logger()


class ActionError(Exception):
    """A user-facing refusal (bad state, not allowed, over budget)."""


@dataclass
class Anywhere:
    settings: Settings
    store: Store
    public_stdb: SpacetimeClient
    brev: BrevCLI
    storage: Storage
    vault: Vault
    catalog: Catalog = field(default_factory=Catalog)

    def __post_init__(self) -> None:
        self.readiness = Readiness(self.settings)
        self.supervisor = Supervisor(self.settings, self.store, self.brev, self.storage, self.vault, self.notify)
        self.supervisor.integrations = self.readiness.integrations

    # ── Notifications ─────────────────────────────────────────────────────

    async def notify(self, w: dict, kind: str, body: str) -> None:
        """Post a status line into the workload's conversation and to linked phones."""
        try:
            await self.store.append_message(int(w["conversationId"]), "assistant", kind, body, int(w["id"]), "system")
        except Exception as exc:
            log.warning("notify.message_failed", error=str(exc))
        try:
            for handle in await self.store.handles_for(w["owner"]):
                await self.store.enqueue_notification(new_id(), w["owner"], "imessage", handle, body)
        except Exception as exc:
            log.warning("notify.imessage_failed", error=str(exc))

    # ── Ownership helpers ─────────────────────────────────────────────────

    async def owned(self, owner: str, workload_id: int) -> dict:
        w = await self.store.workload(workload_id)
        if not w or w["owner"] != owner:
            raise ActionError("Workload not found")
        return w

    async def account(self, owner: str) -> dict:
        acct = await self.store.account(owner)
        if not acct:
            raise ActionError("Create your account first")
        return acct

    async def spend_snapshot(self, owner: str) -> budget.SpendSnapshot:
        workloads = await self.store.workloads()
        month = datetime.now(UTC).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        return budget.SpendSnapshot(
            account_month_cents=sum(
                int(w["accruedCents"]) for w in workloads if w["owner"] == owner and w["createdAt"] >= month
            ),
            platform_cents=sum(int(w["accruedCents"]) for w in workloads),
            active_instances=sum(1 for w in workloads if w["status"] in BILLABLE),
            account_active_kinds=tuple(
                w["kind"] for w in workloads if w["owner"] == owner and w["status"] in BILLABLE | {Status.STOPPED}
            ),
        )

    def _limits(self) -> budget.PlatformLimits:
        return budget.PlatformLimits(self.settings.global_budget_cents, self.settings.max_concurrent_instances)

    # ── Planning ──────────────────────────────────────────────────────────

    async def refresh_prices(self) -> None:
        if self.catalog.stale:
            try:
                self.catalog.apply_live(await self.brev.search_gpu_json())
            except Exception as exc:
                log.info("catalog.live_unavailable", error=str(exc))
                self.catalog.mark_checked()

    async def propose(
        self, owner: str, conversation_id: int, intent: Intent, dataset_upload_id: int | None = None
    ) -> dict:
        """Validate an intent into a plan, check policy, and record it as a workload awaiting approval."""
        acct = await self.account(owner)
        await self.refresh_prices()

        upload = None
        if dataset_upload_id:
            upload = self.vault.upload(dataset_upload_id)
            if not upload or upload["owner"] != owner:
                raise ActionError("That dataset upload wasn't found")
            intent = intent.model_copy(update={"dataset_size_mb": round(upload["size"] / 1e6, 2)})
        if intent.kind in ("fine_tune", "training") and not upload:
            return {"ok": False, "needs": "dataset", "message": "Attach a .jsonl or .csv dataset to fine-tune on."}
        if intent.kind in ("inference", "render"):
            return {
                "ok": False,
                "message": f"{intent.kind.title()} jobs aren't available yet. Desktops and fine-tuning are.",
            }

        result = plan(intent, self.catalog, acct.get("preference", "balanced"))  # type: ignore[arg-type]
        if isinstance(result, Unsupported):
            return {"ok": False, "message": result.reason, "suggestion": result.suggestion}

        plan_doc = result.model_dump(mode="json")
        if upload:
            profile = DatasetProfile.model_validate(upload["profile"])
            try:
                cfg = build_config(
                    params_b=intent.model_params_billions,
                    epochs=intent.epochs,
                    profile=profile,
                    dataset_path="data",
                    vram_gb=result.selected.offer["vram_gb"],
                )
            except DatasetError as exc:
                return {"ok": False, "message": str(exc)}
            plan_doc["inputs"] = {
                "dataset_key": upload["key"],
                "dataset_name": upload["name"],
                "dataset_rows": profile.rows,
                "train_config": cfg.model_dump(mode="json"),
            }

        decision = budget.evaluate(
            kind="desktop" if result.requirements.mode == "interactive" else "batch",
            cost_high_cents=result.selected.estimate.cost_high_cents,
            account=budget.AccountPolicy(
                bool(acct["activated"]), int(acct["monthlyCapCents"]), int(acct["approvalThresholdCents"])
            ),
            spend=await self.spend_snapshot(owner),
            limits=self._limits(),
        )
        plan_doc["policy"] = {"blockers": decision.blockers, "notes": decision.notes}

        wid = new_id()
        offer = result.selected.offer
        await self.store.create_workload(
            id=wid,
            owner=owner,
            conversation_id=conversation_id,
            project_id=0,
            kind="desktop" if result.requirements.mode == "interactive" else "batch",
            title=result.title,
            summary=intent.summary,
            plan_json=json.dumps(plan_doc),
            instance_type=offer["type"],
            gpu_name=offer["gpu"],
            provider=offer["provider"],
            hourly_cents=round(offer["price_per_hour"] * 100),
            est_low_cents=result.selected.estimate.cost_low_cents,
            est_high_cents=result.selected.estimate.cost_high_cents,
            stoppable=bool(offer["stoppable"]),
        )
        await self.store.append_message(conversation_id, "assistant", "plan", result.title, wid, "system")

        auto = decision.allowed and not decision.requires_approval
        if auto:
            await self.approve(owner, wid)
        return {
            "ok": True,
            "workload_id": wid,
            "summary": _plan_summary(result),
            "allowed": decision.allowed,
            "blockers": decision.blockers,
            "auto_approved": auto,
        }

    async def plan_direct(
        self, owner: str, intent: Intent, *, conversation_id: int | None, upload_id: int | None, note: str | None = None
    ) -> dict:
        """Plan without the language model (template launcher). Same `propose`
        path as the agent's tool, so validation and budget policy are identical,
        and the exchange is written into the conversation like a chat turn."""
        await self.account(owner)
        cid = conversation_id
        if cid:
            if not await self.store.conversation_owned(cid, owner):
                raise ActionError("Conversation not found")
        else:
            cid = new_id()
            await self.store.upsert_conversation(cid, owner, _title(intent.summary), "web")
        await self.store.append_message(cid, "user", "text", describe_intent(intent, upload_id, note), 0, "web")
        try:
            result = await self.propose(owner, cid, intent, upload_id)
        except ActionError as exc:
            result = {"ok": False, "message": str(exc)}
        if result.get("ok"):
            message = result["summary"]
            if result.get("auto_approved"):
                message += " It's within your auto-approve limit, so I've started it."
            elif not result.get("allowed", True):
                message += " It can't start yet: " + " ".join(result.get("blockers") or [])
            else:
                message += " Approve the plan to start it."
        else:
            message = result.get("message") or "I couldn't plan that."
            if result.get("suggestion"):
                message += " " + result["suggestion"]
        await self.store.append_message(cid, "assistant", "text", message, int(result.get("workload_id") or 0), "web")
        return {
            "conversation_id": cid,
            "workload_id": result.get("workload_id"),
            "ok": bool(result.get("ok")),
            "message": message,
        }

    async def approve(self, owner: str, workload_id: int) -> dict:
        w = await self.owned(owner, workload_id)
        if w["status"] != Status.PLANNED:
            raise ActionError(f"This plan is already {w['status']}")
        acct = await self.account(owner)
        decision = budget.evaluate(
            kind=w["kind"],
            cost_high_cents=int(w["estHighCents"]),
            account=budget.AccountPolicy(
                bool(acct["activated"]), int(acct["monthlyCapCents"]), int(acct["approvalThresholdCents"])
            ),
            spend=await self.spend_snapshot(owner),
            limits=self._limits(),
        )
        if not decision.allowed:
            raise ActionError(" ".join(decision.blockers))
        await self.store.transition(workload_id, Status.APPROVED, "Approved")
        w["status"] = Status.APPROVED
        self.supervisor.launch(w)
        return {"ok": True}

    async def cancel(self, owner: str, workload_id: int) -> None:
        w = await self.owned(owner, workload_id)
        if w["status"] != Status.PLANNED:
            raise ActionError("Only plans that haven't started can be cancelled")
        await self.store.transition(workload_id, Status.CANCELLED, "Cancelled")

    # ── Lifecycle ─────────────────────────────────────────────────────────

    def _not_busy(self, w: dict) -> None:
        if self.supervisor.busy(w["id"]):
            raise ActionError("Hang on — this machine is still finishing its last operation")

    async def stop(self, owner: str, workload_id: int) -> None:
        w = await self.owned(owner, workload_id)
        if w["status"] != Status.RUNNING:
            raise ActionError("Only running machines can be stopped")
        self._not_busy(w)
        self.supervisor.stop(w)

    async def resume(self, owner: str, workload_id: int) -> None:
        w = await self.owned(owner, workload_id)
        if w["status"] != Status.STOPPED:
            raise ActionError("Only stopped desktops can be resumed")
        acct = await self.account(owner)
        spend = await self.spend_snapshot(owner)
        if spend.active_instances >= self.settings.max_concurrent_instances:
            raise ActionError("Another machine is running. Stop it first.")
        if spend.account_month_cents >= int(acct["monthlyCapCents"]):
            raise ActionError("You've reached your monthly cap. Raise it in Settings to resume.")
        self._not_busy(w)
        self.supervisor.resume(w)

    async def terminate(self, owner: str, workload_id: int) -> None:
        w = await self.owned(owner, workload_id)
        if w["status"] not in (Status.RUNNING, Status.STOPPED, Status.FAILED, Status.SUCCEEDED):
            raise ActionError("This workload can't be deleted right now")
        self._not_busy(w)
        self.supervisor.terminate(w)

    async def save(self, owner: str, workload_id: int) -> None:
        w = await self.owned(owner, workload_id)
        if w["kind"] != "desktop" or w["status"] != Status.RUNNING:
            raise ActionError("Only running desktops can be saved")
        self._not_busy(w)
        self.supervisor.save(w)

    # ── Desktop agent ─────────────────────────────────────────────────────

    async def operate(self, owner: str, workload_id: int, goal: str) -> int:
        w = await self.owned(owner, workload_id)
        if w["kind"] != "desktop" or w["status"] != Status.RUNNING:
            raise ActionError("The desktop needs to be running first")
        goal = goal.strip()[:2000]
        if not goal:
            raise ActionError("Tell the agent what to do")
        if w["controller"] != "agent":
            await self.store.set_controller(workload_id, "agent")
        self.vault.update(workload_id, last_goal=goal)
        return self.supervisor.start_agent(w, goal, self._run_operator)

    async def _run_operator(self, w: dict, goal: str, run_id: int) -> None:
        await self.store.start_agent_run(run_id, w["id"], goal)
        status, result = "failed", ""
        shots = 0

        async def record(kind: str, summary: str, detail: str, jpeg: bytes | None) -> None:
            nonlocal shots
            key = ""
            if jpeg and self.settings.storage_ready:
                shots += 1
                key = Storage.artifact_key(w["owner"], w["id"], f"agent-{run_id}-{shots:03d}.jpg")
                try:
                    await self.storage.put_bytes(key, jpeg, "image/jpeg")
                except Exception:
                    key = ""
            if kind == "observe" and not key:
                return
            await self.store.add_agent_step(run_id, kind, summary, detail, key)
            await self.store.record_usage(w["id"], int(w.get("accruedCents", 0)), touch=True)

        async def has_control() -> bool:
            current = await self.store.workload(w["id"])
            return bool(current and current["controller"] == "agent" and current["status"] == Status.RUNNING)

        try:
            async with connect_screen(self.supervisor.remote(w), self.vault.agent_token(w["id"])) as screen:
                graph = build_operator(
                    llm=llm.vision(self.settings), screen=screen, record=record, has_control=has_control
                )
                final = await graph.ainvoke({"goal": goal, "step": 0, "history": []}, {"recursion_limit": 200})
            status, result = final.get("status", "failed"), final.get("result", "")
        except Exception as exc:
            log.exception("operator.crashed", workload=w["id"])
            result = f"I hit a problem operating the desktop: {exc}"
        finally:
            await self.store.finish_agent_run(run_id, status, result[:2000])
            if result:
                await self.store.append_message(
                    int(w["conversationId"]), "assistant", "agent", result[:4000], int(w["id"]), "system"
                )

    async def resume_agent(self, owner: str, workload_id: int) -> int | None:
        """Hand control back to the agent and continue its last paused goal."""
        w = await self.owned(owner, workload_id)
        await self.store.set_controller(workload_id, "agent")
        goal = self.vault.get(workload_id).get("last_goal")
        if goal and not self.supervisor.agent_running(workload_id):
            return self.supervisor.start_agent(w, goal, self._run_operator)
        return None

    # ── Datasets ──────────────────────────────────────────────────────────

    def register_upload(
        self, owner: str, upload_id: int, key: str, name: str, size: int, profile: DatasetProfile
    ) -> None:
        self.vault.put_upload(
            upload_id,
            {"owner": owner, "key": key, "name": name, "size": size, "profile": profile.model_dump(by_alias=True)},
        )


def describe_intent(intent: Intent, upload_id: int | None = None, note: str | None = None) -> str:
    """The user-side line recorded for a template launch."""
    if intent.kind == "desktop":
        app = intent.application or "terminal"
        text = f"Set up a {app.title() if app != 'vscode' else 'VS Code'} desktop"
        if intent.session_hours:
            text += f" for about {intent.session_hours:g} hours"
    else:
        size = f"{intent.model_params_billions:g}B " if intent.model_params_billions else ""
        text = f"Fine-tune a {size}model"
        if intent.epochs:
            text += f" for {intent.epochs} epoch{'s' if intent.epochs != 1 else ''}"
        if upload_id:
            text += f" on dataset upload {upload_id}"
    if intent.preference and intent.preference != "balanced":
        text += f" ({intent.preference})"
    text += "."
    if note and note.strip():
        text += f" {note.strip()}"
    return text


def _title(text: str) -> str:
    line = (text.strip().splitlines() or ["New chat"])[0]
    return line[:60] + ("…" if len(line) > 60 else "")


def _plan_summary(p: Plan) -> str:
    e = p.selected.estimate
    o = p.selected.offer
    cost = (
        budget.usd(e.cost_high_cents)
        if e.cost_low_cents == e.cost_high_cents
        else f"{budget.usd(e.cost_low_cents)}–{budget.usd(e.cost_high_cents)}"
    )
    return (
        f"{p.title} on an NVIDIA {o['gpu']} ({o['vram_gb']:g} GB) at ${o['price_per_hour']:.2f}/h. "
        f"Estimated {cost} ({e.confidence} confidence). Outputs: {', '.join(p.outputs)}."
    )


_LINK = re.compile(r"^\s*(?:link\s+)?(\d{6})\s*$", re.IGNORECASE)


def parse_link_code(text: str) -> str | None:
    m = _LINK.match(text or "")
    return m.group(1) if m else None
