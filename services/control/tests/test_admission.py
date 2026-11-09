"""Starting machines is serialised so concurrent approvals can't exceed the caps."""

import asyncio

import pytest

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


class OfflineBrev(FakeBrev):
    async def search_gpu_json(self):
        raise RuntimeError("offline")  # price refresh falls back to the snapshot


def make(tmp_path):
    s = Settings(_env_file=None, data_dir=tmp_path, max_concurrent_instances=1)
    store = SlowStore()
    app = Anywhere(s, store, None, OfflineBrev(), Storage(s), Vault(tmp_path / "vault.json"))
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


async def test_approval_refuses_a_machine_brev_no_longer_lists(tmp_path):
    import json

    app, store, launched = make(tmp_path)
    store.add(id=1, kind="batch", status="planned", estHighCents=100, instanceType="g5.xlarge")
    feed = [{"type": o.type, "price_per_hour": o.price_per_hour} for o in app.catalog.offers() if o.type != "g5.xlarge"]
    app.catalog.apply_live(json.dumps(feed))
    with pytest.raises(ActionError, match="isn't offering"):
        await app.approve(OWNER, 1)
    assert launched == []


async def test_concurrent_price_refreshes_share_one_brev_search(tmp_path):
    app, _, _ = make(tmp_path)
    calls = []

    async def search():
        calls.append(1)
        await asyncio.sleep(0.01)
        return "[]"

    app.brev.search_gpu_json = search
    await asyncio.gather(*(app.refresh_prices() for _ in range(5)))
    assert len(calls) == 1


async def test_a_plan_over_the_threshold_needs_a_person_to_approve_it(tmp_path):
    app, store, launched = make(tmp_path)  # approval threshold 0: every plan needs a yes
    store.add(id=1, kind="batch", status="planned", estHighCents=100)
    with pytest.raises(ActionError, match="go-ahead"):
        await app.approve(OWNER, 1, by_human=False)
    assert launched == [] and store.rows[1]["status"] == "planned"
    await app.approve(OWNER, 1)  # the Approve button
    assert launched == [1]


async def test_a_desktop_still_running_from_last_month_counts_toward_this_months_cap(tmp_path):
    from datetime import UTC, datetime, timedelta

    app, store, _ = make(tmp_path)
    month = datetime.now(UTC).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    store.add(id=1, status="running", accruedCents=900, createdAt=month - timedelta(days=3), lastActiveAt=month)
    store.add(
        id=2,
        status="stopped",
        accruedCents=500,
        createdAt=month - timedelta(days=40),
        lastActiveAt=month - timedelta(days=20),
    )
    assert (await app.spend_snapshot(OWNER)).account_month_cents == 900
