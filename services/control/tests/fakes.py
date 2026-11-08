"""In-memory stand-ins for SpacetimeDB, Brev and SSH. Test-only."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from anywhere.brev import BrevDeployFailed, BrevError, CreateResult, Instance, ProvisioningDisabled
from anywhere.config import ProvisioningMode
from anywhere.lifecycle import IllegalTransition, can_transition
from anywhere.remote import Result
from anywhere.stdb import ReducerRejected


class FakeStore:
    def __init__(self):
        self.rows: dict[int, dict] = {}
        self.events: list[tuple[int, str, str]] = []
        self.accounts_: list[dict] = []
        self.platform: tuple | None = None
        self.logs: list[tuple[int, str]] = []
        self.metrics: list[dict] = []
        self.artifacts: list[tuple] = []
        self.conversations: dict[int, dict] = {}
        self.messages: list[tuple] = []

    def add(self, **w) -> dict:
        now = datetime.now(UTC)
        row = {
            "id": 1,
            "owner": "ab" * 32,
            "kind": "desktop",
            "title": "Blender desktop",
            "status": "approved",
            "planJson": json.dumps({"intent": {"application": "blender"}}),
            "instanceType": "g2-standard-4:nvidia-l4:1",
            "gpuName": "L4",
            "hourlyCents": 85,
            "estHighCents": 300,
            "accruedCents": 0,
            "stoppable": True,
            "projectId": 0,
            "createdAt": now,
            "lastActiveAt": now,
            "controller": "agent",
        }
        row.update(w)
        self.rows[row["id"]] = row
        return dict(row)

    async def transition(self, id, to, detail):
        row = self.rows[id]
        if row["status"] != to and not can_transition(row["status"], to):
            raise ReducerRejected(str(IllegalTransition(row["status"], to)))
        row["status"] = to
        row["statusDetail"] = detail

    async def add_event(self, wid, level, message):
        self.events.append((wid, level, message))

    async def switch_workload_machine(self, id, instance_type, gpu_name, provider, hourly_cents):
        row = self.rows[id]
        assert row["status"] == "provisioning"
        row.update(instanceType=instance_type, gpuName=gpu_name, provider=provider, hourlyCents=hourly_cents)

    async def record_usage(self, id, cents, touch=False):
        self.rows[id]["accruedCents"] = max(cents, self.rows[id]["accruedCents"])

    async def workloads(self):
        return [dict(r) for r in self.rows.values()]

    async def workloads_for(self, owner):
        return [w for w in await self.workloads() if w["owner"] == owner]

    async def accounts(self):
        return self.accounts_

    async def update_platform(self, *args):
        self.platform = args

    async def append_logs(self, wid, text):
        self.logs.append((wid, text))

    async def add_metrics(self, wid, points):
        self.metrics.extend(points)

    async def upsert_project(self, *a): ...

    async def add_artifact(self, *a):
        self.artifacts.append(a)

    # Conversations and planning (used by Anywhere.propose / plan_direct)
    async def account(self, identity):
        return next((a for a in self.accounts_ if a["identity"] == identity), None)

    async def upsert_conversation(self, id, owner, title, channel):
        existing = self.conversations.get(id)
        if existing and existing["owner"] != owner:
            raise ReducerRejected("Conversation owner mismatch")
        self.conversations[id] = {"id": id, "owner": owner, "title": title, "channel": channel}

    async def conversation_owned(self, id, owner):
        return self.conversations.get(id, {}).get("owner") == owner

    async def append_message(self, conversation_id, role, kind, body, workload_id=0, channel="web"):
        if conversation_id not in self.conversations:
            raise ReducerRejected("Conversation not found")
        self.messages.append((conversation_id, role, kind, body, workload_id))

    async def create_workload(self, **w):
        self.add(
            id=w["id"],
            owner=w["owner"],
            conversationId=w["conversation_id"],
            kind=w["kind"],
            title=w["title"],
            status="planned",
            planJson=w["plan_json"],
            instanceType=w["instance_type"],
            gpuName=w["gpu_name"],
            hourlyCents=w["hourly_cents"],
            estLowCents=w["est_low_cents"],
            estHighCents=w["est_high_cents"],
            stoppable=w["stoppable"],
        )

    async def handles_for(self, owner):
        return []


class FakeBrev:
    def __init__(self, *, mode=ProvisioningMode.LIVE, fail_wait=False, api_key="bak-test", fail_types=()):
        self.mode = mode
        self.api_key = api_key
        self.fail_wait = fail_wait
        #: Instance types whose deploy Brev "tears down" (BrevDeployFailed).
        self.fail_types = set(fail_types)
        self.types: dict[str, str] = {}
        self.instances: dict[str, str] = {}
        self.calls: list[tuple] = []

    async def create(self, name, itype):
        self.calls.append(("create", name))
        self.types[name] = itype
        if not self.api_key or self.mode == ProvisioningMode.DISABLED:
            raise ProvisioningDisabled("Provisioning is disabled")
        if self.mode == ProvisioningMode.DRY_RUN:
            return CreateResult(name, True, "dry run ok")
        self.instances[name] = "DEPLOYING"
        return CreateResult(name, False, "")

    async def wait_for(self, name, *, want="RUNNING", timeout=0, interval=0, on_change=None):
        if self.fail_wait:
            raise BrevError("capacity unavailable")
        if self.types.get(name) in self.fail_types:
            raise BrevDeployFailed(f"Brev is deleting {name}; the deploy didn't succeed")
        self.instances[name] = want
        return Instance(name, "id", want, "READY", "", "")

    async def refresh_ssh(self, attempts=8): ...

    def has_ssh_host(self, name):
        return True

    async def get(self, name):
        s = self.instances.get(name)
        return Instance(name, "id", s, "READY", "", "") if s else None

    async def list(self):
        return [Instance(n, "id", s, "READY", "", "") for n, s in self.instances.items()]

    async def stop(self, name):
        self.calls.append(("stop", name))
        self.instances[name] = "STOPPING"

    async def start(self, name):
        self.calls.append(("start", name))

    async def delete(self, name):
        self.calls.append(("delete", name))
        self.instances.pop(name, None)


class FakeRemote:
    def __init__(self, host):
        self.host = host

    async def reachable(self):
        return True

    async def run(self, command, **kw):
        return Result(0, "", "")

    async def write_file(self, *a, **kw): ...


def ago(minutes: float) -> datetime:
    return datetime.now(UTC) - timedelta(minutes=minutes)
