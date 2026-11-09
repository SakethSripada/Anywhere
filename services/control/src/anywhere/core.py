"""Application services shared by the HTTP API, the agent's tools and the
messaging bridge. Every way of spending money funnels through `propose` and
`approve`, so validation and budget rules are applied identically everywhere."""

from __future__ import annotations

import asyncio
import json
import math
import re
import shlex
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import structlog

from . import budget, llm, render_bench, replay, sharing
from .brev import BrevCLI, site_prefix
from .catalog import Catalog
from .config import Settings
from .desktop import connect_screen
from .doctor import Readiness
from .ids import new_id
from .lifecycle import BILLABLE, Status
from .operator import PAUSED, build_operator, describe_failure
from .planner import Intent, Plan, Unsupported, plan
from .stdb import SpacetimeClient
from .storage import Storage
from .store import Store
from .supervisor import PROJECTS_DIR, Supervisor, _env
from .training import DatasetError, DatasetProfile, build_config
from .vault import Vault

log = structlog.get_logger()


#: A .blend path relative to ~/Projects: plain names and folders only (no quotes, no `..`).
#: How long the public watch page's database reads are shared between viewers.
WATCH_CACHE_SECONDS = 2.0

SAFE_PATH = re.compile(r"^[\w .@+-]+(/[\w .@+-]+)*\.blend$")


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
    #: Why a desktop-agent run is being halted from outside ("paused", "stopped" or "replaced"),
    #: read by the run as it unwinds so it records the right status.
    _halts: dict[int, str] = field(default_factory=dict, init=False, repr=False)

    def __post_init__(self) -> None:
        self.readiness = Readiness(self.settings, brev=self.brev, storage=self.storage)
        self.supervisor = Supervisor(self.settings, self.store, self.brev, self.storage, self.vault, self.notify)
        self.supervisor.catalog = self.catalog
        self.catalog.persist_to(Path(self.settings.data_dir) / "benched-machines.json")
        self.supervisor.instance_prefix = site_prefix(Path(self.settings.data_dir))
        self.supervisor.integrations = self.readiness.integrations
        #: Serialises "check the budget and concurrency cap, then start a machine" so
        #: two approvals (or an auto-approve racing a manual one) can't both pass.
        self._admission = asyncio.Lock()

    # ── Notifications ─────────────────────────────────────────────────────

    async def notify(self, w: dict, kind: str, body: str, attachment: str | None = None) -> None:
        """Post a status line into the workload's conversation and to linked phones.

        `attachment` is a storage key (an image) the messaging bridge sends after the text."""
        try:
            await self.store.append_message(int(w["conversationId"]), "assistant", kind, body, int(w["id"]), "system")
        except Exception as exc:
            log.warning("notify.message_failed", error=str(exc))
        await self.text_phones(w["owner"], body, attachment)

    async def send_text(self, owner: str, handle: str, body: str, attachment: str | None = None) -> None:
        """Queue one iMessage to one number (the sender of the request), with an optional picture."""
        try:
            nid = new_id()
            if attachment:
                name = attachment.rsplit("/", 1)[-1]
                self.vault.section_put(
                    "notification_attachments",
                    str(nid),
                    {"key": attachment, "name": name, "at": datetime.now(UTC).isoformat()},
                )
            await self.store.enqueue_notification(nid, owner, "imessage", handle, body)
        except Exception as exc:
            log.warning("notify.imessage_failed", error=str(exc))

    async def text_phones(self, owner: str, body: str, attachment: str | None = None) -> int:
        """Queue an iMessage to each of the owner's linked phones; returns how many were queued."""
        sent = 0
        try:
            for handle in await self.store.handles_for(owner):
                nid = new_id()
                if attachment:
                    # The outbox row only carries text; the bridge asks for the picture by id.
                    name = attachment.rsplit("/", 1)[-1]
                    self.vault.section_put(
                        "notification_attachments",
                        str(nid),
                        {"key": attachment, "name": name, "at": datetime.now(UTC).isoformat()},
                    )
                await self.store.enqueue_notification(nid, owner, "imessage", handle, body)
                sent += 1
        except Exception as exc:
            log.warning("notify.imessage_failed", error=str(exc))
        return sent

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

    async def costs(self, owner: str) -> dict:
        """Live spend (each billing segment's exact start, for a per-second meter) and
        what auto-stopping idle desktops has saved."""
        now = datetime.now(UTC)
        running = []
        for w in await self.store.workloads_for(owner):
            if w["status"] not in BILLABLE:
                continue
            start, base = self.supervisor._segment(w)
            running.append(
                {
                    "id": str(w["id"]),
                    "title": w["title"],
                    "gpu": w["gpuName"],
                    "hourly_cents": int(w["hourlyCents"]),
                    "segment_start": start.isoformat() if start else None,
                    "segment_base_cents": base,
                }
            )
        saved, stops = self.supervisor.idle_savings(owner, now)
        return {
            "now": now.isoformat(),
            "running": running,
            "saved_cents": saved,
            "idle_minutes": self.settings.desktop_idle_minutes,
            "session_hours": self.settings.max_session_hours,
            "idle_stops": stops[:20],
        }

    async def spend_snapshot(self, owner: str) -> budget.SpendSnapshot:
        workloads = await self.store.workloads()
        month = datetime.now(UTC).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        return budget.SpendSnapshot(
            account_month_cents=sum(
                int(w["accruedCents"]) for w in workloads if w["owner"] == owner and _this_month(w, month)
            ),
            platform_cents=sum(int(w["accruedCents"]) for w in workloads),
            # An approved plan, or a stopped desktop whose resume has started, is about
            # to provision, so it already takes a slot.
            active_instances=sum(
                1
                for w in workloads
                if w["status"] in BILLABLE | {Status.APPROVED}
                or (w["status"] == Status.STOPPED and self.supervisor.busy(w["id"]))
            ),
            account_active_kinds=tuple(
                w["kind"] for w in workloads if w["owner"] == owner and w["status"] in BILLABLE | {Status.STOPPED}
            ),
        )

    def _limits(self) -> budget.PlatformLimits:
        return budget.PlatformLimits(self.settings.global_budget_cents, self.settings.max_concurrent_instances)

    # ── Planning ──────────────────────────────────────────────────────────

    async def refresh_prices(self) -> None:
        """Refresh live Brev prices when stale. Concurrent callers share one
        `brev search` (it can take up to 45 s) instead of each spawning one."""
        if not self.catalog.stale:
            return
        task = self.__dict__.get("_price_refresh")
        if task is None or task.done():
            task = asyncio.create_task(self._refresh_prices())
            self.__dict__["_price_refresh"] = task
        await asyncio.shield(task)

    async def _refresh_prices(self) -> None:
        try:
            self.catalog.apply_live(await self.brev.search_gpu_json())
        except Exception as exc:
            log.info("catalog.live_unavailable", error=str(exc))
            self.catalog.mark_checked()

    async def _saved_project(self, w: dict) -> bool:
        if not self.settings.storage_ready:
            return False
        _, key = self.supervisor._project(w)
        return bool(await self.storage.head(key))

    async def _scene_desktop(self, owner: str) -> int | None:
        """The desktop a render should take its scene from when none was named: a running
        one first, else the most recently used one with a saved copy of its files."""
        desktops = [w for w in await self.store.workloads_for(owner) if w["kind"] == "desktop"]
        desktops.sort(key=lambda w: w.get("lastActiveAt") or w["createdAt"], reverse=True)
        running = [w for w in desktops if w["status"] == Status.RUNNING]
        if running:
            return int(running[0]["id"])
        for w in desktops:
            if w["status"] == Status.STOPPED and await self._saved_project(w):
                return int(w["id"])
        return None

    async def propose(
        self,
        owner: str,
        conversation_id: int,
        intent: Intent,
        dataset_upload_id: int | None = None,
        *,
        auto_approve: bool = True,
        render_from: int | None = None,
        blend_path: str | None = None,
        scene: str | None = None,
    ) -> dict:
        """Validate an intent into a plan, check policy, and record it as a workload awaiting approval.

        `auto_approve=False` keeps the plan waiting even under the user's auto-approve threshold
        (used for callers, like MCP tokens, that aren't trusted to spend on their own)."""
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
        if intent.kind == "inference":
            return {
                "ok": False,
                "message": "Inference jobs aren't available yet. Desktops, fine-tuning and renders are.",
            }
        source = None
        if intent.kind == "render":
            # Renders copy the project from a desktop's ~/Projects: live if it's running,
            # otherwise its last saved copy in storage (so a phone can start one).
            if blend_path is not None and not blend_path.strip().endswith(".blend"):
                scene, blend_path = scene or blend_path, None  # a name like "alley", not a path
            if not render_from:
                render_from = await self._scene_desktop(owner)
                if not render_from:
                    return {
                        "ok": False,
                        "needs": "source",
                        "message": "Renders copy the scene from one of your desktops. Save it in ~/Projects on a "
                        "desktop first.",
                    }
            source = await self.owned(owner, render_from)
            if source["kind"] != "desktop":
                return {"ok": False, "message": "Renders copy the scene from a desktop, not a job."}
            if source["status"] != Status.RUNNING and not await self._saved_project(source):
                return {
                    "ok": False,
                    "message": f"{source['title']} isn't running and has no saved copy of its files. "
                    "Start it so the scene can be copied.",
                }
            if blend_path is not None:
                blend_path = blend_path.strip().lstrip("/").removeprefix("Projects/")
                if not SAFE_PATH.match(blend_path) or ".." in blend_path.split("/"):
                    return {"ok": False, "message": "Give a .blend file inside ~/Projects, like scenes/alley.blend."}
            if scene is not None:
                scene = " ".join(scene.split())[:80] or None

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

        if source is not None:
            plan_doc["inputs"] = {
                "source_workload_id": int(source["id"]),
                "source_title": source["title"],
                "blend_path": blend_path,
                "scene": scene,
            }

        decision = budget.evaluate(
            kind="desktop" if result.requirements.mode == "interactive" else "batch",
            cost_high_cents=result.selected.estimate.cost_high_cents,
            account=budget.AccountPolicy(
                bool(acct["activated"]), int(acct["monthlyCapCents"]), int(acct["approvalThresholdCents"])
            ),
            spend=await self.spend_snapshot(owner),
            limits=self._limits(),
            machines=result.machines,
            hours_high=result.selected.estimate.hours_high,
            max_session_hours=self.settings.max_session_hours,
        )
        plan_doc["policy"] = {
            "blockers": [b for b in decision.blockers if b not in decision.waits],
            "waits": decision.waits,
            "notes": decision.notes,
        }

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

        auto = auto_approve and decision.allowed and not decision.requires_approval
        if auto:
            try:
                # Not a person's yes: if spend moved over the threshold since `evaluate`, it waits.
                await self.approve(owner, wid, by_human=False)
            except ActionError:
                auto = False
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

    async def approve(self, owner: str, workload_id: int, *, by_human: bool = True) -> dict:
        """Start a plan. `by_human` says a person explicitly approved it (the Approve
        button, an MCP token with the spend scope, a confirmed chat reply). A plan over the
        account's approval threshold is refused without one, so a model talked into
        approving (prompt injection via logs, say) can't spend past it on its own."""
        # Refresh outside the admission lock so a slow `brev search` never makes
        # every other approve/resume wait behind it.
        await self.refresh_prices()
        async with self._admission:
            return await self._approve(owner, workload_id, by_human=by_human)

    async def _approve(self, owner: str, workload_id: int, *, by_human: bool = True) -> dict:
        w = await self.owned(owner, workload_id)
        if w["status"] != Status.PLANNED:
            raise ActionError(f"This plan is already {w['status']}")
        # A plan can sit for a while before it's approved; make sure Brev still
        # lists its machine type so `brev create` isn't asked for one it can't make.
        # (Prices were refreshed by `approve` before taking the admission lock.)
        if not self.catalog.available(w["instanceType"]):
            raise ActionError(
                f"Brev isn't offering {w['instanceType']} right now. Ask me for a new plan and I'll pick another machine."
            )
        acct = await self.account(owner)
        plan_doc = json.loads(w["planJson"])
        machines = int(plan_doc.get("machines") or 1)
        decision = budget.evaluate(
            kind=w["kind"],
            cost_high_cents=int(w["estHighCents"]),
            account=budget.AccountPolicy(
                bool(acct["activated"]), int(acct["monthlyCapCents"]), int(acct["approvalThresholdCents"])
            ),
            spend=await self.spend_snapshot(owner),
            limits=self._limits(),
            machines=machines,
            hours_high=(plan_doc.get("selected") or {}).get("estimate", {}).get("hours_high"),
            max_session_hours=self.settings.max_session_hours,
        )
        if not decision.allowed:
            raise ActionError(" ".join(decision.blockers))
        if decision.requires_approval and not by_human:
            raise ActionError(
                "This plan needs the user's own go-ahead. Ask them to approve it (reply yes, or press Approve)."
            )
        if machines > 1:
            parts = await self._split_render(w, plan_doc, machines)
            for part in parts:
                self.supervisor.launch(part)
            return {"ok": True, "machines": len(parts), "workload_ids": [int(p["id"]) for p in parts]}
        await self.store.transition(workload_id, Status.APPROVED, "Approved")
        w["status"] = Status.APPROVED
        self.supervisor.launch(w)
        return {"ok": True}

    async def _split_render(self, w: dict, plan_doc: dict, machines: int) -> list[dict]:
        """Turn an approved split render into one render job per GPU, each with its own frames.

        The approved workload becomes part 1; the rest are created beside it in the same
        conversation. Every part keeps the farm's id so their frames land in one folder.

        All parts are created before any is approved, and a failure part way cancels the
        ones made and restores the farm's plan: an orphaned APPROVED part would hold a
        concurrency slot forever (with max_concurrent_instances=1, blocking every launch)."""
        frames = int(plan_doc.get("intent", {}).get("render_frames") or 1)
        machines = max(1, min(machines, frames))
        base, extra = divmod(frames, machines)
        sizes = [base + (1 if i < extra else 0) for i in range(machines)]
        low, high = int(w["estLowCents"]), int(w["estHighCents"])
        farm = int(w["id"])
        part_low, part_high = math.ceil(low / machines), math.ceil(high / machines)
        planned: list[tuple[int, str, dict]] = []  # (id, title, plan) per part, part 1 first
        offset = 0
        for i, size in enumerate(sizes):
            part_plan = json.loads(json.dumps(plan_doc))
            part_plan["machines"] = 1
            part_plan.setdefault("intent", {})["render_frames"] = size
            part_plan.setdefault("inputs", {})["chunk"] = {
                "index": i,
                "count": machines,
                "offset": offset,
                "frames": size,
                "total": frames,
                "farm_id": farm,
            }
            title = f"Render part {i + 1} of {machines} (frames {offset + 1}–{offset + size} of {frames})"
            planned.append((farm if i == 0 else new_id(), title, part_plan))
            offset += size

        created: list[int] = []
        farm_rewritten = False
        try:
            for pid, title, part_plan in planned[1:]:
                await self.store.create_workload(
                    id=pid,
                    owner=w["owner"],
                    conversation_id=int(w["conversationId"]),
                    project_id=int(w.get("projectId", 0)),
                    kind=w["kind"],
                    title=title,
                    summary=w.get("summary", ""),
                    plan_json=json.dumps(part_plan),
                    instance_type=w["instanceType"],
                    gpu_name=w["gpuName"],
                    provider=w.get("provider", ""),
                    hourly_cents=int(w["hourlyCents"]),
                    est_low_cents=part_low,
                    est_high_cents=part_high,
                    stoppable=bool(w.get("stoppable", False)),
                )
                created.append(pid)
            _, title, part_plan = planned[0]
            await self.store.update_workload_plan(farm, title, json.dumps(part_plan), part_low, part_high)
            farm_rewritten = True
            # The farm last: if anything fails before it, it is still a plan the user can retry.
            for i, (pid, _, _) in [*list(enumerate(planned))[1:], (0, planned[0])]:
                await self.store.transition(pid, Status.APPROVED, f"Approved (part {i + 1} of {machines})")
        except Exception:
            log.exception("render.split_failed", farm=farm)
            for pid in created:
                try:
                    await self.store.transition(pid, Status.CANCELLED, "Cancelled: the split render couldn't start")
                except Exception as exc:
                    log.warning("render.split_cleanup_failed", workload=pid, error=str(exc))
            if farm_rewritten:
                try:
                    await self.store.update_workload_plan(farm, w["title"], w["planJson"], low, high)
                except Exception as exc:
                    log.warning("render.split_restore_failed", workload=farm, error=str(exc))
            raise ActionError("Couldn't set up the split render. Nothing was started; try approving again.") from None

        parts: list[dict] = []
        for pid, _, part_plan in planned:
            part = await self.store.workload(pid) or {**w, "id": pid}
            parts.append({**part, "planJson": json.dumps(part_plan), "status": Status.APPROVED})
        return parts

    async def cancel(self, owner: str, workload_id: int) -> None:
        w = await self.owned(owner, workload_id)
        if w["status"] != Status.PLANNED:
            raise ActionError("Only plans that haven't started can be cancelled")
        await self.store.transition(workload_id, Status.CANCELLED, "Cancelled")

    # ── Lifecycle ─────────────────────────────────────────────────────────

    def _not_busy(self, w: dict) -> None:
        if self.supervisor.busy(w["id"]):
            raise ActionError("Hang on, this machine is still finishing its last operation")

    async def stop(self, owner: str, workload_id: int) -> None:
        w = await self.owned(owner, workload_id)
        if w["status"] != Status.RUNNING:
            raise ActionError("Only running machines can be stopped")
        self._not_busy(w)
        self.supervisor.stop(w)

    async def resume(self, owner: str, workload_id: int) -> None:
        async with self._admission:
            await self._resume(owner, workload_id)

    async def _resume(self, owner: str, workload_id: int) -> None:
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

    async def operate(
        self,
        owner: str,
        workload_id: int,
        goal: str,
        *,
        replace: bool = False,
        channel: str = "web",
        take_control: bool = False,
    ) -> int:
        """Start the desktop agent on `goal`. With `replace`, a task already in
        progress is stopped first (the user steering it from chat). A goal that
        came over iMessage (`channel`) is answered there too when it finishes.

        While the user holds the controls (they took over, or stopped the agent) this
        refuses, unless `take_control` says the user themselves just asked for it."""
        w = await self.owned(owner, workload_id)
        if w["kind"] != "desktop" or w["status"] != Status.RUNNING:
            raise ActionError("The desktop needs to be running first")
        if w["controller"] == "user" and not take_control:
            raise ActionError(
                "The user has the controls on this desktop. Ask them to hand back (the Hand back button) first."
            )
        goal = goal.strip()[:2000]
        if not goal:
            raise ActionError("Tell the agent what to do")
        if replace and self.supervisor.agent_running(workload_id):
            self._halts[workload_id] = "replaced"
            try:
                await self.supervisor.stop_agent(workload_id)
            finally:
                self._halts.pop(workload_id, None)
        if w["controller"] != "agent":
            await self.store.set_controller(workload_id, "agent")
        self.vault.update(workload_id, last_goal=goal, agent_channel=channel)
        return self.supervisor.start_agent(w, goal, self._run_operator)

    def set_progress_updates(self, workload_id: int, every_minutes: int) -> int:
        """Text a progress update (with the latest screenshot) every N minutes while
        the desktop agent works on this machine; 0 turns updates off."""
        minutes = max(0, min(int(every_minutes), 60))
        self.vault.update(workload_id, update_every_min=minutes)
        return minutes

    async def halt_agent(self, owner: str, workload_id: int, *, pause: bool = False) -> None:
        """Stop the desktop agent and give the user the controls.

        A pause (the user taking over) keeps the run resumable: handing back
        continues its goal. A stop ends it."""
        await self.owned(owner, workload_id)
        # Controls first, so a step that checks after this point sees the user holds them;
        # a step already past its check is cancelled below.
        await self.store.set_controller(workload_id, "user")
        self._halts[workload_id] = "paused" if pause else "stopped"
        try:
            await self.supervisor.stop_agent(workload_id)
        finally:
            self._halts.pop(workload_id, None)

    #: How often a running desktop agent checks whether a progress text is due, and
    #: the seconds in one "minute" of the user's update interval (shortened in tests).
    UPDATE_TICK = 15.0
    UPDATE_MINUTE = 60.0

    async def _run_operator(self, w: dict, goal: str, run_id: int) -> None:
        await self.store.start_agent_run(run_id, w["id"], goal)
        status, result = "failed", ""
        shots = 0
        last_touch = float("-inf")
        #: The newest stored screenshot and the last thing the agent did, for texts.
        latest: dict[str, str] = {"key": "", "act": ""}

        async def record(kind: str, summary: str, detail: str, jpeg: bytes | None) -> None:
            nonlocal shots, last_touch
            key = ""
            if jpeg and self.settings.storage_ready:
                shots += 1
                key = Storage.artifact_key(w["owner"], w["id"], f"agent-{run_id}-{shots:03d}.jpg")
                try:
                    await self.storage.put_bytes(key, jpeg, "image/jpeg")
                except Exception:
                    key = ""
            if key:
                latest["key"] = key
            if kind == "act":
                latest["act"] = summary
            if kind == "observe" and not key:
                return
            await self.store.add_agent_step(run_id, kind, summary, detail, key)
            # Activity only feeds the 20-minute idle check, so one touch every 30 s
            # is plenty; each one rewrites the workload row for every subscriber.
            now = asyncio.get_running_loop().time()
            if now - last_touch >= 30:
                last_touch = now
                await self.store.record_usage(w["id"], int(w.get("accruedCents", 0)), touch=True)

        async def has_control() -> bool:
            current = await self.store.workload(w["id"])
            return bool(current and current["controller"] == "agent" and current["status"] == Status.RUNNING)

        async def progress_texts() -> None:
            """Text the latest step and screenshot every N minutes, if the user asked for updates."""
            loop = asyncio.get_running_loop()
            last_sent = loop.time()
            while True:
                await asyncio.sleep(self.UPDATE_TICK)
                every = int(self.vault.get(int(w["id"])).get("update_every_min") or 0)
                if not every or loop.time() - last_sent < every * self.UPDATE_MINUTE:
                    continue
                last_sent = loop.time()
                doing = f" Last step: {latest['act']}." if latest["act"] else ""
                body = f'Update on {w["title"]}: still working on "{_clip(goal, 90)}".{doing}'
                await self.text_phones(w["owner"], body, latest["key"] or None)

        ticker = asyncio.create_task(progress_texts())
        try:
            async with connect_screen(self.supervisor.remote(w), self.vault.agent_token(w["id"])) as screen:
                graph = build_operator(
                    llm=llm.vision(self.settings), screen=screen, record=record, has_control=has_control
                )
                final = await graph.ainvoke({"goal": goal, "step": 0, "history": []}, {"recursion_limit": 200})
            status, result = final.get("status", "failed"), final.get("result", "")
        except asyncio.CancelledError:
            # Halted from outside: the user took over or stopped it, or the machine is stopping.
            halt = self._halts.get(int(w["id"]))
            status = "paused" if halt == "paused" else "stopped"
            result = {"paused": PAUSED, "stopped": "Stopped. You have the controls."}.get(halt or "", "")
            raise
        except Exception as exc:
            log.exception("operator.crashed", workload=w["id"])
            result = describe_failure(exc)
        finally:
            ticker.cancel()
            await self.store.finish_agent_run(run_id, status, result[:2000])
            if result:
                await self.store.append_message(
                    int(w["conversationId"]), "assistant", "agent", result[:4000], int(w["id"]), "system"
                )
            # Only a paused run is continued by a hand-back; a finished or stopped one isn't
            # redone. A replaced run's goal is already the new one, so it's left alone.
            if (
                status != "paused"
                and self._halts.get(int(w["id"])) != "replaced"
                and self.vault.get(int(w["id"])).get("last_goal") == goal
            ):
                self.vault.update(int(w["id"]), last_goal="")
            # A task asked for over iMessage is answered there, with a picture of the result.
            if status in ("done", "failed") and self.vault.get(int(w["id"])).get("agent_channel") == "imessage":
                body = (
                    f"Done on {w['title']}: {_clip(result, 600)}"
                    if status == "done"
                    else f"I couldn't finish that on {w['title']}: {_clip(result, 600)}"
                )
                await self.text_phones(w["owner"], body, latest["key"] or None)

    # ── Render estimates ──────────────────────────────────────────────────

    async def estimate_render(
        self, owner: str, workload_id: int, path: str | None = None, samples: int | None = None, frames: int = 1
    ) -> dict:
        """Time a quick test render of a saved .blend on a running desktop and extrapolate.

        Uses the newest .blend in ~/Projects unless `path` (relative to ~/Projects) is given."""
        w = await self.owned(owner, workload_id)
        if w["kind"] != "desktop" or w["status"] != Status.RUNNING:
            raise ActionError("Test renders need a running desktop")
        if path is not None:
            path = path.strip().lstrip("/").removeprefix("Projects/")
            if not path.endswith(".blend") or ".." in path.split("/") or not SAFE_PATH.match(path):
                raise ActionError("Give a .blend file inside ~/Projects, like scenes/alley.blend")
        remote = self.supervisor.remote(w)
        docker = 'D=docker; docker ps >/dev/null 2>&1 || D="sudo docker";'
        if path is None:
            found = await remote.run(
                f"cd {PROJECTS_DIR} 2>/dev/null && find . -name '*.blend' -printf '%T@ %P\\n' | sort -nr | head -1",
                check=False,
                timeout=30,
            )
            path = found.stdout.strip().partition(" ")[2]
            if not path:
                raise ActionError("No saved .blend in ~/Projects yet. Save your scene there first (File > Save).")
        await remote.run(
            f"{docker} $D exec -i anywhere-desktop sh -c 'cat > /tmp/anywhere-probe.py'",
            input=_env("render-probe.py").encode(),
            timeout=30,
        )
        cfg = json.dumps({"samples": samples, "percent": 25})
        res = await remote.run(
            f"{docker} $D exec anywhere-desktop timeout 600 blender -b {shlex.quote('/projects/' + path)} "
            f"-P /tmp/anywhere-probe.py -- {shlex.quote(cfg)} 2>&1 | tail -40",
            check=False,
            timeout=660,
        )
        line = next((ln for ln in res.stdout.splitlines() if ln.startswith("::probe::")), None)
        if line is None:
            tail = "\n".join(res.stdout.strip().splitlines()[-5:])
            raise ActionError(f"The test render didn't finish. Blender said: {tail[-500:] or 'nothing'}")
        probe = json.loads(line.removeprefix("::probe::"))
        result = render_bench.extrapolate(probe, frames)
        hourly = int(w["hourlyCents"])
        compare = []
        for gpu in render_bench.SAMPLES_PER_MINUTE:
            ratio = render_bench.relative_speed(gpu, w["gpuName"])
            if ratio and gpu != render_bench.gpu_key(w["gpuName"]):
                compare.append({"gpu": gpu, "seconds_per_frame": round(result["seconds_per_frame"] / ratio, 1)})
        return {
            "file": f"~/Projects/{path}",
            "gpu": w["gpuName"],
            "device": probe["device"],
            "resolution": f"{probe['full_width']}x{probe['full_height']}",
            "samples": probe["target_samples"],
            **result,
            "estimated_cost": budget.usd(math.ceil(result["seconds_per_frame"] * frames / 3600 * hourly)),
            "measured_on": f"two test renders at {probe['probe_width']}x{probe['probe_height']}",
            "other_gpus": sorted(compare, key=lambda c: c["seconds_per_frame"]),
            "note": "Denoising adds a little on top. Other-GPU times scale this measurement by Blender Open Data benchmarks.",
        }

    # ── Agent replays ─────────────────────────────────────────────────────

    async def _replay_frames(self, owner: str, workload_id: int, run_id: int) -> tuple[dict, list[dict]]:
        await self.owned(owner, workload_id)
        run = next((r for r in await self.store.agent_runs(workload_id) if int(r["id"]) == run_id), None)
        if run is None:
            raise ActionError("That agent run wasn't found on this machine")
        frames = replay.frames_from_steps(await self.store.agent_steps(run_id))
        frames = [f for f in frames if Storage.owns(owner, f["key"])]
        return run, frames

    async def replay(self, owner: str, workload_id: int, run_id: int) -> dict:
        """The frames of one desktop-agent run, with short-lived links to each screenshot."""
        run, frames = await self._replay_frames(owner, workload_id, run_id)
        if frames and not self.settings.storage_ready:
            raise ActionError("Replays need object storage, which isn't set up on this server")
        started, ended = run.get("startedAt"), run.get("endedAt")
        return {
            "run_id": run_id,
            "goal": run["goal"],
            "status": run["status"],
            "result": run.get("result") or "",
            "seconds": round((ended - started).total_seconds()) if started and ended else None,
            "frames": [
                {**{k: v for k, v in f.items() if k != "key"}, "url": self.storage.presign_get(f["key"], expires=3600)}
                for f in frames
            ],
        }

    async def replay_gif(self, owner: str, workload_id: int, run_id: int) -> dict:
        """Render (once) and link an annotated timelapse GIF of a desktop-agent run."""
        if not self.settings.storage_ready:
            raise ActionError("Timelapses need object storage, which isn't set up on this server")
        run, frames = await self._replay_frames(owner, workload_id, run_id)
        if not frames:
            raise ActionError("This run has no screenshots to make a timelapse from")
        key = Storage.artifact_key(owner, workload_id, f"agent-{run_id}-timelapse.gif")
        # One render per GIF: a double click used to build (and list) it twice.
        locks: dict[str, asyncio.Lock] = self.__dict__.setdefault("_gif_locks", {})
        lock = locks.setdefault(key, asyncio.Lock())
        try:
            async with lock:
                if not await self.storage.head(key):
                    # Download the screenshots in parallel (a few at a time), not one by one.
                    gate = asyncio.Semaphore(8)

                    async def fetch(k: str) -> bytes:
                        async with gate:
                            return await self.storage.get_bytes(k)

                    images = list(await asyncio.gather(*(fetch(f["key"]) for f in frames)))
                    gif = await asyncio.to_thread(replay.timelapse_gif, images, frames, run["goal"])
                    await self.storage.put_bytes(key, gif, "image/gif")
                    await self.store.add_artifact(
                        new_id(), workload_id, f"Agent timelapse: {run['goal'][:60]}", key, "image/gif", len(gif)
                    )
        finally:
            if not lock.locked() and locks.get(key) is lock:
                locks.pop(key, None)
        return {
            "url": self.storage.presign_get(key, expires=3600, filename=f"anywhere-agent-{run_id}.gif"),
            "frames": len(frames),
        }

    # ── Watch links ───────────────────────────────────────────────────────

    def _share_of(self, wid: int) -> tuple[str, dict] | None:
        for key, rec in self.vault.section_items(sharing.SECTION):
            if rec["workload_id"] == wid:
                return key, rec
        return None

    async def create_share(self, owner: str, workload_id: int, hours: float = 4) -> dict:
        """A new watch-only link for a running desktop (replacing any earlier one)."""
        w = await self.owned(owner, workload_id)
        if w["kind"] != "desktop":
            raise ActionError("Only desktops can be shared")
        if w["status"] != Status.RUNNING:
            raise ActionError("Start the desktop first; people can watch it while it runs")
        # Desktops started before watch links existed don't have the view-only stream
        # yet; the start script is idempotent and brings up whatever's missing.
        try:
            await self.supervisor.ensure_desktop_services(w)
        except Exception as exc:
            raise ActionError(f"Couldn't set up the watch stream on the desktop: {exc}") from exc
        revoked = self.revoke_share_now(workload_id)
        token, rec = sharing.make(workload_id, owner, hours)
        self.vault.section_put(sharing.SECTION, sharing.digest(token), rec)
        return {"token": token, "expires_at": rec["expires_at"], "replaced": revoked}

    async def share_status(self, owner: str, workload_id: int) -> dict:
        await self.owned(owner, workload_id)
        found = self._share_of(workload_id)
        if not found or not sharing.live(found[1]):
            return {"active": False}
        return {"active": True, "expires_at": found[1]["expires_at"], "created_at": found[1]["created_at"]}

    async def revoke_share(self, owner: str, workload_id: int) -> str | None:
        await self.owned(owner, workload_id)
        return self.revoke_share_now(workload_id)

    def revoke_share_now(self, workload_id: int) -> str | None:
        """Drop the desktop's link; returns its digest so open streams can be closed."""
        found = self._share_of(workload_id)
        if found:
            self.vault.section_pop(sharing.SECTION, found[0])
            return found[0]
        return None

    async def watched(self, token: str) -> tuple[dict, dict]:
        """The share record and workload behind a token, or ActionError if it's not usable."""
        rec = self.vault.section_get(sharing.SECTION, sharing.digest(token))
        if not sharing.live(rec):
            raise ActionError("This watch link has expired or was turned off")
        assert rec is not None
        w = await self.store.workload(rec["workload_id"])
        if not w or w["owner"] != rec["owner"]:
            raise ActionError("This watch link has expired or was turned off")
        return rec, w

    async def watch_view(self, token: str) -> dict:
        """What someone with a watch link may see: the desktop's state and the agent's steps.

        Every viewer polls this every couple of seconds; the link is checked on each call
        (in memory), but the database reads behind it are shared for WATCH_CACHE_SECONDS."""
        digest = sharing.digest(token)
        rec = self.vault.section_get(sharing.SECTION, digest)
        if not sharing.live(rec):
            raise ActionError("This watch link has expired or was turned off")
        cache: dict[str, tuple[float, dict]] = self.__dict__.setdefault("_watch_cache", {})
        now = asyncio.get_running_loop().time()
        hit = cache.get(digest)
        if hit and now - hit[0] < WATCH_CACHE_SECONDS:
            return hit[1]
        for key in [k for k, (at, _) in cache.items() if now - at >= WATCH_CACHE_SECONDS]:
            del cache[key]
        view = await self._watch_view(token)
        cache[digest] = (now, view)
        return view

    async def _watch_view(self, token: str) -> dict:
        rec, w = await self.watched(token)
        agent = None
        runs = await self.store.agent_runs(int(w["id"]))
        if runs:
            run = runs[0]
            steps = await self.store.agent_step_summaries(int(run["id"]))
            agent = {
                "goal": run["goal"],
                "status": run["status"],
                "result": run.get("result") or "",
                "steps": [
                    {"seq": int(s["seq"]), "kind": s["kind"], "summary": s["summary"]}
                    for s in steps
                    if s["kind"] != "observe"
                ][-40:],
            }
        plan = json.loads(w.get("planJson") or "{}")
        return {
            "title": w["title"],
            "status": w["status"],
            "gpu": w["gpuName"],
            "app": plan.get("intent", {}).get("application"),
            "controller": w.get("controller") or "",
            "expires_at": rec["expires_at"],
            "agent": agent,
        }

    async def resume_agent(self, owner: str, workload_id: int) -> int | None:
        """Hand control back to the agent and continue its last paused goal.

        `last_goal` is cleared when a run finishes, fails or is stopped, so this only
        restarts a run the user paused by taking over."""
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


def _this_month(w: dict, month: datetime) -> bool:
    """Whether a workload's spend counts toward this month's cap: made this month, or
    active in it. By createdAt alone, a desktop started last month and still running never
    counted. Matches the supervisor's cap check; a workload spanning two months counts its
    whole accrual (the conservative side for a cap)."""
    return any(
        isinstance(at, datetime) and at >= month
        for at in (w.get("createdAt"), w.get("lastActiveAt"), w.get("updatedAt"), w.get("startedAt"))
    )


def _clip(text: str, limit: int) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


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
