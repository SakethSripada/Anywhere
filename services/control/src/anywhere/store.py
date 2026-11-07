"""Typed facade over the SpacetimeDB module.

Argument order for each reducer matches its declaration in
spacetime/module/src/index.ts (the HTTP API takes positional arguments).
"""

from __future__ import annotations

from typing import Any

from .stdb import SpacetimeClient, identity_arg


class Store:
    def __init__(self, client: SpacetimeClient):
        self.client = client

    # ── Accounts ──────────────────────────────────────────────────────────
    async def activate_account(self, identity: str, activated: bool) -> None:
        await self.client.call("activate_account", identity_arg(identity), activated)

    async def accounts(self) -> list[dict]:
        return await self.client.sql("SELECT * FROM worker_accounts")

    async def account(self, identity: str) -> dict | None:
        return next((a for a in await self.accounts() if a["identity"] == identity), None)

    # ── Conversations ─────────────────────────────────────────────────────
    async def upsert_conversation(self, id: int, owner: str, title: str, channel: str) -> None:
        await self.client.call("upsert_conversation", id, identity_arg(owner), title, channel)

    async def append_message(
        self, conversation_id: int, role: str, kind: str, body: str, workload_id: int = 0, channel: str = "web"
    ) -> None:
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

    async def transition(self, id: int, to: str, detail: str) -> None:
        await self.client.call("transition_workload", id, to, detail)

    async def record_usage(self, id: int, accrued_cents: int, touch: bool = False) -> None:
        await self.client.call("record_usage", id, accrued_cents, touch)

    async def set_controller(self, workload_id: int, controller: str) -> None:
        await self.client.call("set_controller", workload_id, controller)

    async def workloads(self) -> list[dict]:
        return await self.client.sql("SELECT * FROM worker_workloads")

    async def workload(self, id: int) -> dict | None:
        return next((w for w in await self.workloads() if w["id"] == id), None)

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
        rows = await self.client.sql("SELECT * FROM worker_agent_runs")
        return sorted((r for r in rows if r["workloadId"] == workload_id), key=lambda r: r["startedAt"], reverse=True)

    async def agent_steps(self, run_id: int) -> list[dict]:
        rows = await self.client.sql("SELECT * FROM worker_agent_steps")
        return sorted((r for r in rows if r["runId"] == run_id), key=lambda r: r["seq"])

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
        rows = await self.client.sql("SELECT * FROM worker_handles")
        return next((r["owner"] for r in rows if r["handle"] == handle), None)

    async def handles_for(self, owner: str) -> list[str]:
        rows = await self.client.sql("SELECT * FROM worker_handles")
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
