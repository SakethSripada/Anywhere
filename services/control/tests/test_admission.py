"""Starting machines is serialised so concurrent approvals can't exceed the caps."""

import asyncio

from anywhere.config import Settings
from anywhere.core import ActionError, Anywhere
from anywhere.storage import Storage
from anywhere.vault import Vault

from .fakes import FakeBrev, FakeStore

OWNER = "ab" * 32


class SlowStore(FakeStore):
    """Yields to the event loop on every read, like a real network round trip."""

    async def workload(self, id):
        await asyncio.sleep(0)
        r = self.rows.get(id)
        return dict(r) if r else None

    async def workloads(self):
        await asyncio.sleep(0)
        return await super().workloads()

    async def account(self, identity):
        await asyncio.sleep(0)
        return {"identity": identity, "activated": True, "monthlyCapCents": 5000, "approvalThresholdCents": 0}


def make(tmp_path):
    s = Settings(_env_file=None, data_dir=tmp_path, max_concurrent_instances=1)
    store = SlowStore()
    app = Anywhere(s, store, None, FakeBrev(), Storage(s), Vault(tmp_path / "vault.json"))
    launched: list[int] = []
    app.supervisor.launch = lambda w: launched.append(w["id"])
    return app, store, launched


async def test_concurrent_approvals_respect_the_concurrency_cap(tmp_path):
    app, store, launched = make(tmp_path)
    store.add(id=1, kind="batch", status="planned", estHighCents=100)
    store.add(id=2, kind="batch", status="planned", estHighCents=100)
    results = await asyncio.gather(app.approve(OWNER, 1), app.approve(OWNER, 2), return_exceptions=True)
    assert len(launched) == 1
    assert sum(isinstance(r, ActionError) for r in results) == 1


async def test_an_approved_plan_counts_as_active(tmp_path):
    app, store, _ = make(tmp_path)
    store.add(id=1, kind="batch", status="approved")
    assert (await app.spend_snapshot(OWNER)).active_instances == 1
