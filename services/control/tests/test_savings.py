"""Auto-stop savings: only time the session limit wouldn't have cut anyway."""

from datetime import UTC, datetime, timedelta

from anywhere import savings
from anywhere.brev import instance_name

from .fakes import FakeBrev, ago
from .test_supervisor import drain, make

T0 = datetime(2026, 11, 8, 12, 0, tzinfo=UTC)
W = {"id": 7, "owner": "alice", "title": "Blender desktop", "gpuName": "L4", "hourlyCents": 85}


def test_savings_stop_at_the_session_limit_or_the_resume():
    # Billing began at 12:00; idle-stopped at 12:40; the 1 h limit would have stopped it at 13:00.
    rec = savings.record(T0 + timedelta(minutes=40), T0, 1, W)
    assert savings.saved_cents(rec, T0 + timedelta(minutes=50)) == 85 * 10 / 60
    assert savings.still_counting(rec, T0 + timedelta(minutes=50))
    assert savings.saved_cents(rec, T0 + timedelta(hours=5)) == 85 * 20 / 60  # capped at the limit
    assert not savings.still_counting(rec, T0 + timedelta(hours=5))
    rec["resumed_at"] = (T0 + timedelta(minutes=45)).isoformat()
    assert savings.saved_cents(rec, T0 + timedelta(hours=5)) == 85 * 5 / 60
    # Stopped past the limit (the limit itself stops it): nothing saved.
    late = savings.record(T0 + timedelta(hours=2), T0, 1, W)
    assert savings.saved_cents(late, T0 + timedelta(hours=3)) == 0


async def test_idle_stops_are_recorded_and_closed_on_resume(tmp_path):
    brev = FakeBrev()
    sup, store, _ = make(tmp_path, brev, desktop_idle_minutes=20, max_session_hours=4)
    store.add(status="running", lastActiveAt=ago(45))
    brev.instances[instance_name(1)] = "RUNNING"
    sup.vault.update(1, segment_start=ago(50).isoformat(), segment_base=0)
    await sup.tick()
    await drain(sup)
    [(key, rec)] = sup.vault.section_items(savings.SECTION)
    assert rec["workload_id"] == 1 and savings.still_counting(rec)
    limit = datetime.fromisoformat(rec["limit_at"]) - datetime.fromisoformat(rec["stopped_at"])
    assert timedelta(hours=3, minutes=9) < limit < timedelta(hours=3, minutes=11)
    sup.resume(store.rows[1])
    await drain(sup)
    assert sup.vault.section_get(savings.SECTION, key)["resumed_at"]


async def test_other_guard_stops_are_not_savings(tmp_path):
    brev = FakeBrev()
    sup, store, _ = make(tmp_path, brev, max_session_hours=1)
    store.add(status="running", lastActiveAt=ago(1))
    brev.instances[instance_name(1)] = "RUNNING"
    sup.vault.update(1, segment_start=ago(90).isoformat(), segment_base=0)
    await sup.tick()
    await drain(sup)
    assert store.rows[1]["status"] == "stopped"
    assert sup.vault.section_items(savings.SECTION) == []


async def test_costs_report_exact_segments_and_savings(tmp_path):
    from anywhere.config import ProvisioningMode, Settings
    from anywhere.core import Anywhere
    from anywhere.stdb import SpacetimeClient
    from anywhere.storage import Storage
    from anywhere.vault import Vault

    from .test_mcp import ALICE, BOB, McpStore, account

    settings = Settings(_env_file=None, data_dir=tmp_path, spacetime_worker_token="w")
    store = McpStore()
    store.accounts_ = [account(ALICE), account(BOB)]
    app = Anywhere(
        settings=settings,
        store=store,
        public_stdb=SpacetimeClient("http://127.0.0.1:1", "anywhere"),
        brev=FakeBrev(mode=ProvisioningMode.LIVE),
        storage=Storage(settings),
        vault=Vault(tmp_path / "vault.json"),
    )
    store.add(id=11, owner=ALICE, kind="desktop", status="running", conversationId=1, gpuName="L4", hourlyCents=85)
    store.add(id=12, owner=ALICE, kind="desktop", status="stopped", conversationId=1, gpuName="L4", hourlyCents=85)
    store.add(id=13, owner=BOB, kind="desktop", status="running", conversationId=2, gpuName="L4", hourlyCents=85)
    app.vault.update(11, segment_start=ago(30).isoformat(), segment_base=40)
    app.vault.section_put(savings.SECTION, "12:1", savings.record(ago(10), ago(40), 1, {**W, "id": 12, "owner": ALICE}))
    app.vault.section_put(savings.SECTION, "13:1", savings.record(ago(10), ago(40), 1, {**W, "id": 13, "owner": BOB}))
    r = await app.costs(ALICE)
    assert [x["id"] for x in r["running"]] == ["11"] and r["running"][0]["segment_base_cents"] == 40
    assert [s["id"] for s in r["idle_stops"]] == ["12"]  # never another user's
    assert 85 * 9 / 60 < r["saved_cents"] < 85 * 11 / 60
