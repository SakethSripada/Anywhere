"""Typed facade over the SpacetimeDB module.

Argument order for each reducer matches its declaration in
spacetime/module/src/index.ts (the HTTP API takes positional arguments).
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

import structlog

from .stdb import SpacetimeClient, SpacetimeError, identity_arg

_SPACED_DASH = re.compile(r"\s*[\u2014\u2013]\s*(?=\S)")
_RANGE_DASH = re.compile(r"(?<=\d)\u2013(?=\d)")


def plain_dashes(text: str) -> str:
    """Models use em dashes despite being told not to; the product never shows them.
    "T4 — the cheapest" becomes "T4, the cheapest"; "5–10" becomes "5-10"."""
    text = _RANGE_DASH.sub("-", text)
    return _SPACED_DASH.sub(", ", text).replace("\u2014", "").replace("\u2013", "")


log = structlog.get_logger()

_HEX_IDENTITY = re.compile(r"^(0x)?[0-9a-fA-F]{64}$")


def _sql_str(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _sql_identity(hex_identity: str) -> str:
    if not _HEX_IDENTITY.match(hex_identity):
        raise ValueError("not a hex identity")
    return "0x" + hex_identity.removeprefix("0x").lower()


class Store:
    def __init__(self, client: SpacetimeClient):
        self.client = client

    async def _where(self, view: str, clause: str, fallback) -> list[dict]:
        """`SELECT * FROM view WHERE clause`, so only matching rows cross the wire.

        If the server rejects the filter, fall back to scanning the view and
        filtering here, so a SQL dialect difference can never break a lookup.
        """
        try:
            return await self.client.sql(f"SELECT * FROM {view} WHERE {clause}")
        except SpacetimeError as exc:
            log.warning("store.filter_fallback", view=view, error=str(exc)[:200])
            return [r for r in await self.client.sql(f"SELECT * FROM {view}") if fallback(r)]

    # ── Accounts ──────────────────────────────────────────────────────────
    async def activate_account(self, identity: str, activated: bool) -> None:
        await self.client.call("activate_account", identity_arg(identity), activated)

    async def accounts(self) -> list[dict]:
        return await self.client.sql("SELECT * FROM worker_accounts")

    async def account(self, identity: str) -> dict | None:
        try:
            clause = f"identity = {_sql_identity(identity)}"
        except ValueError:
            return None
        rows = await self._where("worker_accounts", clause, lambda a: a["identity"] == identity)
        return next((a for a in rows if a["identity"] == identity), None)

    # ── Conversations ─────────────────────────────────────────────────────
    async def upsert_conversation(self, id: int, owner: str, title: str, channel: str) -> None:
        await self.client.call("upsert_conversation", id, identity_arg(owner), title, channel)

    async def conversation_owned(self, conversation_id: int, owner: str) -> bool:
        cid = int(conversation_id)  # interpolated into SQL: must be an integer
        rows = await self._where("worker_conversations", f"id = {cid}", lambda r: r["id"] == cid)
        return any(r["id"] == cid and r["owner"] == owner for r in rows)

    async def append_message(
        self, conversation_id: int, role: str, kind: str, body: str, workload_id: int = 0, channel: str = "web"
    ) -> None:
        if role == "assistant" and not body.lstrip().startswith(("{", "[")):
            body = plain_dashes(body)
        await self.client.call("append_message", conversation_id, role, kind, body, workload_id, channel)

    # ── Workloads ─────────────────────────────────────────────────────────
    async def create_workload(self, **w: Any) -> None:
        await self.client.call(
            "create_workload",
            w["id"],
            identity_arg(w["owner"]),
            w["conversation_id"],
            w.get("project_id", 0),
            w["kind"],
            w["title"],
            w["summary"],
            w["plan_json"],
            w["instance_type"],
            w["gpu_name"],
            w["provider"],
            w["hourly_cents"],
            w["est_low_cents"],
            w["est_high_cents"],
            w["stoppable"],
        )

    async def update_workload_plan(
        self, id: int, title: str, plan_json: str, est_low_cents: int, est_high_cents: int
    ) -> None:
        await self.client.call("update_workload_plan", id, title, plan_json, est_low_cents, est_high_cents)

    async def transition(self, id: int, to: str, detail: str) -> None:
        await self.client.call("transition_workload", id, to, detail)

    async def record_usage(self, id: int, accrued_cents: int, touch: bool = False) -> None:
        await self.client.call("record_usage", id, accrued_cents, touch)

    async def set_controller(self, workload_id: int, controller: str) -> None:
        await self.client.call("set_controller", workload_id, controller)

    async def workloads(self) -> list[dict]:
        return await self.client.sql("SELECT * FROM worker_workloads")

    async def workloads_for(self, owner: str) -> list[dict]:
        """One owner's workloads, filtered on the server instead of scanning every user's."""
        try:
            clause = f"owner = {_sql_identity(owner)}"
        except ValueError:
            return []
        rows = await self._where("worker_workloads", clause, lambda w: w["owner"] == owner)
        return [w for w in rows if w["owner"] == owner]

    async def workload(self, id: int) -> dict | None:
        wid = int(id)  # interpolated into SQL: must be an integer
        rows = await self._where("worker_workloads", f"id = {wid}", lambda w: w["id"] == wid)
        return next((w for w in rows if w["id"] == wid), None)

    async def telemetry(self, workload_id: int) -> dict[str, list[dict]]:
        """Everything recorded for one workload, for the agent's inspect tool."""
        wid = int(workload_id)  # interpolated into SQL: must be an integer
        views = {
            "events": "worker_events",
            "logs": "worker_logs",
            "metrics": "worker_metrics",
            "artifacts": "worker_artifacts",
            "agent_runs": "worker_agent_runs",
        }
        results = await asyncio.gather(
            *(self.client.sql(f"SELECT * FROM {view} WHERE workloadId = {wid}") for view in views.values())
        )
        return dict(zip(views, results, strict=True))

    # ── Telemetry ─────────────────────────────────────────────────────────
    async def add_event(self, workload_id: int, level: str, message: str) -> None:
        await self.client.call("add_event", workload_id, level, message)

    async def append_logs(self, workload_id: int, text: str) -> None:
        await self.client.call("append_logs", workload_id, text)

    async def add_metrics(self, workload_id: int, points: list[dict]) -> None:
        await self.client.call("add_metrics", workload_id, points)

    # ── Agent ─────────────────────────────────────────────────────────────
    async def start_agent_run(self, id: int, workload_id: int, goal: str) -> None:
        await self.client.call("start_agent_run", id, workload_id, goal)

    async def add_agent_step(
        self, run_id: int, kind: str, summary: str, detail: str = "", screenshot_key: str = ""
    ) -> None:
        await self.client.call("add_agent_step", run_id, kind, summary, detail, screenshot_key)

    async def finish_agent_run(self, id: int, status: str, result: str) -> None:
        await self.client.call("finish_agent_run", id, status, result)

    async def agent_runs(self, workload_id: int) -> list[dict]:
        wid = int(workload_id)  # interpolated into SQL: must be an integer
        rows = await self.client.sql(f"SELECT * FROM worker_agent_runs WHERE workloadId = {wid}")
        return sorted(rows, key=lambda r: r["startedAt"], reverse=True)

    async def agent_steps(self, run_id: int) -> list[dict]:
        rid = int(run_id)  # interpolated into SQL: must be an integer
        rows = await self.client.sql(f"SELECT * FROM worker_agent_steps WHERE runId = {rid}")
        return sorted(rows, key=lambda r: r["seq"])

    async def agent_step_summaries(self, run_id: int) -> list[dict]:
        """Steps of a run without their (up to 4 kB) `detail` text, for polling callers."""
        rid = int(run_id)  # interpolated into SQL: must be an integer
        try:
            rows = await self.client.sql(
                f"SELECT seq, kind, summary, screenshotKey FROM worker_agent_steps WHERE runId = {rid}"
            )
        except SpacetimeError:
            return await self.agent_steps(rid)
        return sorted(rows, key=lambda r: r["seq"])

    # ── Files ─────────────────────────────────────────────────────────────
    async def upsert_project(
        self, id: int, owner: str, name: str, app: str, prefix: str, size: int, saved: bool
    ) -> None:
        await self.client.call("upsert_project", id, identity_arg(owner), name, app, prefix, size, saved)

    async def add_artifact(self, id: int, workload_id: int, name: str, key: str, content_type: str, size: int) -> None:
        await self.client.call("add_artifact", id, workload_id, name, key, content_type, size)

    # ── Messaging ─────────────────────────────────────────────────────────
    async def issue_link_code(self, owner: str, handle: str) -> None:
        await self.client.call("issue_link_code", identity_arg(owner), handle)

    async def link_handle(self, handle: str, code: str, channel: str) -> None:
        await self.client.call("link_handle", handle, code, channel)

    async def handle_owner(self, handle: str) -> str | None:
        rows = await self._where("worker_handles", f"handle = {_sql_str(handle)}", lambda r: r["handle"] == handle)
        return next((r["owner"] for r in rows if r["handle"] == handle), None)

    async def handles_for(self, owner: str) -> list[str]:
        try:
            clause = f"owner = {_sql_identity(owner)}"
        except ValueError:
            return []
        rows = await self._where("worker_handles", clause, lambda r: r["owner"] == owner)
        return [r["handle"] for r in rows if r["owner"] == owner]

    async def enqueue_notification(self, id: int, owner: str, channel: str, handle: str, body: str) -> None:
        await self.client.call("enqueue_notification", id, identity_arg(owner), channel, handle, body)

    # ── Platform ──────────────────────────────────────────────────────────
    async def update_platform(
        self,
        mode: str,
        budget_cents: int,
        spent_cents: int,
        active: int,
        max_concurrent: int,
        integrations_json: str,
    ) -> None:
        await self.client.call(
            "update_platform", mode, budget_cents, spent_cents, active, max_concurrent, integrations_json
        )
