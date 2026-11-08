"""Render estimates on a desktop and render jobs, against fake machines."""

import json

import pytest

import anywhere.supervisor as sup_module
from anywhere.config import ProvisioningMode, Settings
from anywhere.core import ActionError, Anywhere
from anywhere.planner import Intent
from anywhere.remote import RemoteError, Result
from anywhere.stdb import SpacetimeClient
from anywhere.storage import Storage
from anywhere.supervisor import metric_points
from anywhere.vault import Vault

from .fakes import FakeBrev
from .test_mcp import ALICE, McpStore, account

PROBE = {
    "device": "OPTIX: NVIDIA L4",
    "full_width": 1920,
    "full_height": 1080,
    "target_samples": 256,
    "probe_width": 480,
    "probe_height": 270,
    "points": [[8, 2.0], [32, 5.0]],
    "frame_start": 1,
    "frame_end": 250,
}


class ScriptedRemote:
    """Answers `run` from a list of (substring, stdout) rules; records every command."""

    rules: list[tuple[str, str]] = []
    log: list[str] = []

    def __init__(self, host):
        self.host = host

    async def run(self, command, *, timeout=120, input=None, check=True):
        ScriptedRemote.log.append(command)
        for needle, out in ScriptedRemote.rules:
            if needle in command:
                return Result(0, out, "")
        return Result(0, "", "")

    async def write_file(self, path, content, mode="0644"):
        ScriptedRemote.log.append(f"write {path}")

    async def reachable(self):
        return True


@pytest.fixture
def app(tmp_path, monkeypatch):
    ScriptedRemote.rules, ScriptedRemote.log = [], []
    settings = Settings(_env_file=None, data_dir=tmp_path, spacetime_worker_token="w")
    store = McpStore()
    store.accounts_ = [account(ALICE)]
    a = Anywhere(
        settings=settings,
        store=store,
        public_stdb=SpacetimeClient("http://127.0.0.1:1", "anywhere"),
        brev=FakeBrev(mode=ProvisioningMode.LIVE),
        storage=Storage(settings),
        vault=Vault(tmp_path / "vault.json"),
    )
    a.supervisor.remote_factory = ScriptedRemote
    a.supervisor.remote = lambda w: ScriptedRemote(str(w["id"]))
    relays: list[tuple[str, str]] = []

    async def fake_relay(src, src_cmd, dst, dst_cmd):
        relays.append((src_cmd, dst_cmd))

    monkeypatch.setattr(sup_module, "_relay", fake_relay)
    a.relays = relays  # type: ignore[attr-defined]
    return a


def desktop(app, wid=11, status="running"):
    return app.store.add(
        id=wid, owner=ALICE, kind="desktop", status=status, conversationId=1, gpuName="L4", hourlyCents=85
    )


# ── Test render on a running desktop ────────────────────────────────────────


async def test_estimate_render_times_a_test_render_and_extrapolates(app):
    desktop(app)
    ScriptedRemote.rules = [
        ("find .", "1731000000.0 scenes/alley.blend\n"),
        ("blender -b", "noise\n::probe::" + json.dumps(PROBE) + "\n"),
    ]
    r = await app.estimate_render(ALICE, 11, frames=24)
    assert r["file"] == "~/Projects/scenes/alley.blend"
    assert r["seconds_per_frame"] == pytest.approx(1 + 3 / 24 * 256 * 16, rel=1e-3)
    assert r["total_minutes"] == pytest.approx(r["seconds_per_frame"] * 24 / 60, rel=1e-2)
    assert r["estimated_cost"].startswith("$")
    faster = {c["gpu"]: c["seconds_per_frame"] for c in r["other_gpus"]}
    assert faster["L40S"] < r["seconds_per_frame"] < faster["T4"]
    blender = next(c for c in ScriptedRemote.log if "blender -b" in c)
    assert "blender -b /projects/scenes/alley.blend -P" in blender
    # Names with spaces reach Blender as one quoted argument.
    ScriptedRemote.log.clear()
    await app.estimate_render(ALICE, 11, path="scenes/alley v2.blend")
    assert "'/projects/scenes/alley v2.blend'" in next(c for c in ScriptedRemote.log if "blender -b" in c)


async def test_estimate_render_explains_what_is_missing(app):
    desktop(app)
    with pytest.raises(ActionError, match="No saved .blend"):
        await app.estimate_render(ALICE, 11)
    for bad in ("../../etc/x.blend", "a'b.blend", "scene.txt"):
        with pytest.raises(ActionError, match="inside ~/Projects"):
            await app.estimate_render(ALICE, 11, path=bad)
    ScriptedRemote.rules = [("blender -b", "Error: Cannot read file\n")]
    with pytest.raises(ActionError, match="didn't finish"):
        await app.estimate_render(ALICE, 11, path="scene.blend")
    desktop(app, wid=12, status="stopped")
    with pytest.raises(ActionError, match="running desktop"):
        await app.estimate_render(ALICE, 12)


# ── Render jobs ─────────────────────────────────────────────────────────────


async def test_render_jobs_need_a_running_source_desktop(app):
    intent = Intent(kind="render", summary="render the alley", render_frames=3)
    assert (await app.propose(ALICE, 1, intent))["needs"] == "source"
    desktop(app, status="stopped")
    stopped = await app.propose(ALICE, 1, intent, render_from=11)
    assert not stopped["ok"] and "running" in stopped["message"]
    app.store.rows[11]["status"] = "running"
    bad = await app.propose(ALICE, 1, intent, render_from=11, blend_path="../x.blend")
    assert not bad["ok"]
    ok = await app.propose(
        ALICE, 1, intent, render_from=11, blend_path="Projects/scenes/alley.blend", auto_approve=False
    )
    assert ok["ok"]
    plan = json.loads(app.store.rows[ok["workload_id"]]["planJson"])
    assert plan["inputs"] == {
        "source_workload_id": 11,
        "source_title": "Blender desktop",
        "blend_path": "scenes/alley.blend",
    }
    assert plan["render_time"]["frames"] == 3


async def test_configure_render_copies_the_project_and_starts_the_runner(app):
    desktop(app)
    job = app.store.add(id=20, owner=ALICE, kind="batch", status="configuring", conversationId=1, gpuName="L4")
    ScriptedRemote.rules = [("find .", "1731000000.0 scenes/alley v2.blend\n")]
    plan = {
        "requirements": {"environment": "blender-render"},
        "intent": {"render_frames": 24, "render_samples": 256},
        "inputs": {"source_workload_id": 11, "blend_path": None},
    }
    await app.supervisor._configure_render(job, app.supervisor.remote(job), plan)
    assert app.relays and "--exclude=./renders" in app.relays[0][0]
    assert any("write ~/workspace/anywhere/job/run.sh" in c for c in ScriptedRemote.log)
    assert app.store.rows[20]["status"] == "running"
    assert app.vault.get(20)["blend"] == "scenes/alley v2.blend"


async def test_configure_render_refuses_unsafe_file_names(app):
    desktop(app)
    job = app.store.add(id=20, owner=ALICE, kind="batch", status="configuring", conversationId=1)
    ScriptedRemote.rules = [("find .", '1731000000.0 evil"$(reboot).blend\n')]
    plan = {"intent": {}, "inputs": {"source_workload_id": 11, "blend_path": None}}
    with pytest.raises(RemoteError, match="Rename"):
        await app.supervisor._configure_render(job, app.supervisor.remote(job), plan)
    assert not any("write" in c for c in ScriptedRemote.log)


async def test_finished_render_copies_frames_back_without_storage(app):
    desktop(app)
    plan = {"requirements": {"environment": "blender-render"}, "inputs": {"source_workload_id": 11}}
    job = app.store.add(id=20, owner=ALICE, kind="batch", status="running", conversationId=1, planJson=json.dumps(plan))
    await app.supervisor._finish_batch(job, app.supervisor.remote(job))
    assert app.store.rows[20]["status"] == "succeeded"
    assert app.relays[-1][1].startswith("mkdir -p ~/workspace/anywhere/projects/renders/20")
    # With the source desktop gone and no storage, the frames have nowhere to go: say so.
    app.store.rows[11]["status"] = "stopped"
    job2 = app.store.add(
        id=21, owner=ALICE, kind="batch", status="running", conversationId=1, planJson=json.dumps(plan)
    )
    await app.supervisor._finish_batch(job2, app.supervisor.remote(job2))
    assert app.store.rows[21]["status"] == "failed"
    assert "object storage" in app.store.rows[21]["statusDetail"]


def test_render_progress_becomes_metrics():
    rows = [
        json.dumps({"frame": 5, "done": 1, "total": 4, "seconds": 12.5}),
        json.dumps({"frame": 6, "done": 2, "total": 4, "seconds": 11}),
    ]
    points = metric_points(rows)
    assert {"name": "progress", "step": 2, "value": 0.5} in points
    assert {"name": "seconds_per_frame", "step": 1, "value": 12.5} in points
