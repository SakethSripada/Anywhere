"""Watch-only share links: hashed tokens, expiry, replacement, and what watchers see."""

import json
from datetime import UTC, datetime, timedelta

import pytest

from anywhere import sharing
from anywhere.config import ProvisioningMode, Settings
from anywhere.core import ActionError, Anywhere
from anywhere.stdb import SpacetimeClient
from anywhere.storage import Storage
from anywhere.vault import Vault

from .fakes import FakeBrev
from .test_mcp import ALICE, BOB, McpStore, account


@pytest.fixture
def app(tmp_path):
    settings = Settings(_env_file=None, data_dir=tmp_path, spacetime_worker_token="w")
    store = McpStore()
    store.accounts_ = [account(ALICE), account(BOB)]
    a = Anywhere(
        settings=settings,
        store=store,
        public_stdb=SpacetimeClient("http://127.0.0.1:1", "anywhere"),
        brev=FakeBrev(mode=ProvisioningMode.LIVE),
        storage=Storage(settings),
        vault=Vault(tmp_path / "vault.json"),
    )
    a.ensured = []  # type: ignore[attr-defined]

    async def ensure(w):
        a.ensured.append(w["id"])

    a.supervisor.ensure_desktop_services = ensure
    plan = json.dumps({"intent": {"application": "blender"}})
    store.add(id=11, owner=ALICE, kind="desktop", status="running", conversationId=1, gpuName="L4", planJson=plan)
    store.add(id=12, owner=ALICE, kind="desktop", status="stopped", conversationId=1)
    store.runs = [
        {"id": 7, "workloadId": 11, "goal": "Add a sphere", "status": "running", "result": "", "startedAt": 1}
    ]
    store.steps = [
        {"runId": 7, "seq": 1, "kind": "observe", "summary": "Looked at the screen", "screenshotKey": "k"},
        {"runId": 7, "seq": 2, "kind": "act", "summary": "Open the Add menu", "screenshotKey": ""},
    ]
    return a


async def test_links_are_stored_hashed_and_show_the_desktop_and_agent(app, tmp_path):
    made = await app.create_share(ALICE, 11, hours=2)
    assert app.ensured == [11]  # the view-only stream is brought up first
    assert made["token"] not in (tmp_path / "vault.json").read_text()
    view = await app.watch_view(made["token"])
    assert view["title"] and view["status"] == "running" and view["app"] == "blender"
    assert view["agent"]["goal"] == "Add a sphere"
    assert [s["summary"] for s in view["agent"]["steps"]] == ["Open the Add menu"]
    assert "owner" not in view
    assert (await app.share_status(ALICE, 11))["active"]


async def test_a_new_link_replaces_the_old_and_revoking_ends_it(app):
    first = await app.create_share(ALICE, 11)
    second = await app.create_share(ALICE, 11)
    assert second["replaced"] == sharing.digest(first["token"])
    with pytest.raises(ActionError, match="expired or was turned off"):
        await app.watch_view(first["token"])
    assert await app.revoke_share(ALICE, 11) == sharing.digest(second["token"])
    with pytest.raises(ActionError):
        await app.watch_view(second["token"])
    assert not (await app.share_status(ALICE, 11))["active"]


async def test_links_expire_and_only_owners_of_running_desktops_can_share(app):
    made = await app.create_share(ALICE, 11)
    key = sharing.digest(made["token"])
    past = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
    app.vault.section_update(sharing.SECTION, key, expires_at=past)
    with pytest.raises(ActionError, match="expired"):
        await app.watch_view(made["token"])
    with pytest.raises(ActionError):
        await app.create_share(BOB, 11)
    with pytest.raises(ActionError, match="Start the desktop"):
        await app.create_share(ALICE, 12)
    assert sharing.make(1, ALICE, hours=500)[1]["expires_at"] < (datetime.now(UTC) + timedelta(hours=25)).isoformat()


async def test_viewers_share_the_watch_reads_but_revoking_still_cuts_them_off(app):
    made = await app.create_share(ALICE, 11)
    reads = 0
    original = app.store.agent_runs

    async def counting(wid):
        nonlocal reads
        reads += 1
        return await original(wid)

    app.store.agent_runs = counting
    for _ in range(5):  # five viewers polling at once
        await app.watch_view(made["token"])
    assert reads == 1
    await app.revoke_share(ALICE, 11)
    with pytest.raises(ActionError):
        await app.watch_view(made["token"])  # the cache never outlives the link
