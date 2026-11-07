"""In-memory stand-ins for SpacetimeDB, Brev and SSH. Test-only."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from anywhere.brev import BrevError, CreateResult, Instance, ProvisioningDisabled
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

    async def record_usage(self, id, cents, touch=False):
        self.rows[id]["accruedCents"] = max(cents, self.rows[id]["accruedCents"])

    async def workloads(self):
        return [dict(r) for r in self.rows.values()]

    async def accounts(self):
        return self.accounts_

    async def update_platform(self, *args):
        self.platform = args

    async def append_logs(self, *a): ...
    async def add_metrics(self, *a): ...
    async def upsert_project(self, *a): ...
    async def add_artifact(self, *a): ...


class FakeBrev:
    def __init__(self, *, mode=ProvisioningMode.LIVE, fail_wait=False, api_key="bak-test"):
        self.mode = mode
        self.api_key = api_key
        self.fail_wait = fail_wait
        self.instances: dict[str, str] = {}
        self.calls: list[tuple] = []

    async def create(self, name, itype, script):
        self.calls.append(("create", name))
        if not self.api_key or self.mode == ProvisioningMode.DISABLED:
            raise ProvisioningDisabled("Provisioning is disabled")
        if self.mode == ProvisioningMode.DRY_RUN:
            return CreateResult(name, True, "dry run ok")
        self.instances[name] = "DEPLOYING"
        return CreateResult(name, False, "")

    async def wait_for(self, name, *, want="RUNNING", timeout=0, interval=0):
        if self.fail_wait:
            raise BrevError("capacity unavailable")
        self.instances[name] = want
        return Instance(name, "id", want, "READY", "", "")

    async def refresh_ssh(self): ...

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
