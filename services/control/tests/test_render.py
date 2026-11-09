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
from anywhere.supervisor import metric_points, pick_blend
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

    def popen(self, command, *, stdin=None, stdout=None):
        ScriptedRemote.log.append(f"popen {command}")
        return command

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
        "scene": None,
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


# ── Split renders (render farm) ─────────────────────────────────────────────


async def test_approving_a_split_render_launches_one_part_per_gpu(app):
    app.settings.max_concurrent_instances = 6
    desktop(app)
    updates = []

    async def update_workload_plan(id, title, plan_json, est_low, est_high):
        updates.append(id)
        app.store.rows[id].update(title=title, planJson=plan_json, estLowCents=est_low, estHighCents=est_high)

    app.store.update_workload_plan = update_workload_plan
    launched = []
    app.supervisor.launch = lambda w: launched.append(w)
    intent = Intent(kind="render", summary="animation", render_frames=10, render_machines=4)
    farm = await app.propose(ALICE, 1, intent, render_from=11, auto_approve=False)
    total_high = app.store.rows[farm["workload_id"]]["estHighCents"]
    result = await app.approve(ALICE, farm["workload_id"])
    assert result["machines"] == 4 and len(launched) == 4 and updates == [farm["workload_id"]]
    chunks = [json.loads(w["planJson"])["inputs"]["chunk"] for w in launched]
    assert [c["frames"] for c in chunks] == [3, 3, 2, 2]  # 10 frames, as even as possible
    assert [c["offset"] for c in chunks] == [0, 3, 6, 8]
    assert {c["farm_id"] for c in chunks} == {farm["workload_id"]}
    assert all(app.store.rows[int(w["id"])]["status"] == "approved" for w in launched)
    assert app.store.rows[farm["workload_id"]]["title"] == "Render part 1 of 4 (frames 1–3 of 10)"
    assert sum(app.store.rows[int(w["id"])]["estHighCents"] for w in launched) >= total_high


async def test_a_split_render_waits_for_room_for_all_its_gpus(app):
    app.settings.max_concurrent_instances = 2
    desktop(app)  # already one running machine
    intent = Intent(kind="render", summary="animation", render_frames=8, render_machines=4)
    plan = await app.propose(ALICE, 1, intent, render_from=11, auto_approve=False)
    assert plan["ok"] and not plan["allowed"]
    assert any("4 GPUs at once" in b for b in plan["blockers"])


async def test_render_parts_render_their_own_frames_into_one_folder(app):
    desktop(app)
    notes = []

    async def notify(w, kind, body, attachment=None):
        notes.append(body)

    app.supervisor.notify = notify
    ScriptedRemote.rules = [("find .", "1731000000.0 alley.blend\n")]
    farm_id = 30
    parts = []
    for i, (offset, size) in enumerate([(0, 3), (3, 3)]):
        plan = {
            "requirements": {"environment": "blender-render"},
            "intent": {"render_frames": size},
            "inputs": {
                "source_workload_id": 11,
                "blend_path": None,
                "chunk": {"index": i, "count": 2, "offset": offset, "frames": size, "total": 6, "farm_id": farm_id},
            },
        }
        parts.append(
            app.store.add(
                id=farm_id + i,
                owner=ALICE,
                kind="batch",
                status="configuring",
                conversationId=1,
                planJson=json.dumps(plan),
            )
        )
    await app.supervisor._configure_render(parts[1], app.supervisor.remote(parts[1]), json.loads(parts[1]["planJson"]))
    assert app.store.rows[31]["statusDetail"] == "Rendering frames 4–6 of 6 of alley.blend"
    # Part 2 finishing first doesn't announce; the last part to finish does.
    await app.supervisor._finish_batch(app.store.rows[31], app.supervisor.remote(parts[1]))
    assert app.relays[-1][1].startswith("mkdir -p ~/workspace/anywhere/projects/renders/30")
    assert not any("All 6 frames" in n for n in notes)
    app.store.rows[30]["status"] = "running"
    await app.supervisor._finish_batch(app.store.rows[30], app.supervisor.remote(parts[0]))
    assert any("All 6 frames are rendered across 2 GPUs" in n for n in notes)


# ── Renders started from a phone ────────────────────────────────────────────


class SavedStorage:
    """Object storage holding saved projects; records what was streamed in and out."""

    def __init__(self, keys=()):
        self.keys = set(keys)
        self.uploads: list[str] = []
        self.downloads: list[tuple[str, str]] = []

    async def head(self, key):
        return {"ContentLength": 1} if key in self.keys else None

    async def download_stream(self, key, proc):
        self.downloads.append((key, proc))

    async def upload_stream(self, proc, key, content_type, **kw):
        self.uploads.append(key)
        self.keys.add(key)
        return 2048

    def presign_get(self, key, expires=900, filename=None):
        return f"https://bucket.example/{key}"


def with_storage(app, keys=()):
    app.settings = app.supervisor.settings = Settings(
        _env_file=None,
        data_dir=app.settings.data_dir,
        spacetime_worker_token="w",
        s3_bucket="b",
        s3_access_key_id="k",
        s3_secret_access_key="s",
    )
    app.storage = app.supervisor.storage = SavedStorage(keys)
    return app.storage


def test_scene_names_pick_the_matching_blend():
    listing = "1731000300.0 scenes/city.blend\n1731000200.0 Alley Night v2.blend\n1731000100.0 renders/x.blend\n"
    assert pick_blend(listing, "my alley scene") == "Alley Night v2.blend"
    assert pick_blend(listing, None) == "scenes/city.blend"  # newest
    with pytest.raises(RemoteError, match="couldn't find a scene called .forest.*city.blend"):
        pick_blend(listing, "forest")
    with pytest.raises(RemoteError, match="no saved .blend"):
        pick_blend("1731000100.0 renders/x.blend\n", None)


async def test_a_render_can_start_from_a_stopped_desktops_saved_files(app):
    intent = Intent(kind="render", summary="render my alley scene", render_frames=1)
    desktop(app, status="stopped")
    with_storage(app, {Storage.project_key(ALICE, 11)})
    # No desktop named: the one with the saved files is used, and a bare name is a scene, not a path.
    r = await app.propose(ALICE, 1, intent, blend_path="alley", auto_approve=False)
    assert r["ok"], r
    inputs = json.loads(app.store.rows[r["workload_id"]]["planJson"])["inputs"]
    assert inputs["source_workload_id"] == 11 and inputs["scene"] == "alley" and inputs["blend_path"] is None


async def test_configure_render_restores_a_saved_project_and_finds_the_scene(app):
    desktop(app, status="stopped")
    storage = with_storage(app, {Storage.project_key(ALICE, 11)})
    job = app.store.add(id=20, owner=ALICE, kind="batch", status="configuring", conversationId=1, gpuName="L4")
    ScriptedRemote.rules = [("find .", "1731000300.0 city.blend\n1731000200.0 alley.blend\n")]
    plan = {"intent": {"render_frames": 1}, "inputs": {"source_workload_id": 11, "blend_path": None, "scene": "alley"}}
    await app.supervisor._configure_render(job, app.supervisor.remote(job), plan)
    assert storage.downloads and storage.downloads[0][0] == Storage.project_key(ALICE, 11)
    assert not app.relays  # nothing copied from a live desktop
    assert app.vault.get(20)["blend"] == "alley.blend"


async def test_finished_render_texts_the_first_frame(app):
    desktop(app)
    storage = with_storage(app)
    sent = []

    async def notify(w, kind, body, attachment=None):
        sent.append((body, attachment))

    app.supervisor.notify = notify
    plan = {"requirements": {"environment": "blender-render"}, "inputs": {"source_workload_id": 11}}
    job = app.store.add(id=20, owner=ALICE, kind="batch", status="running", conversationId=1, planJson=json.dumps(plan))
    await app.supervisor._finish_batch(job, app.supervisor.remote(job))
    preview = Storage.artifact_key(ALICE, 20, "first-frame.jpg")
    assert preview in storage.uploads
    assert sent[-1][1] == preview and "finished" in sent[-1][0]


async def test_notification_pictures_reach_the_bridge(app):
    storage = with_storage(app)
    app.store.handles_for = lambda owner: _value(["+15550100199"])
    queued = []
    app.store.enqueue_notification = lambda *a: _value(queued.append(a))
    app.store.append_message = lambda *a: _value(None)
    w = {"id": 20, "owner": ALICE, "conversationId": 1}
    await app.notify(w, "status", "Render finished.", attachment="users/a/workloads/20/first-frame.jpg")
    nid = queued[0][0]
    att = app.vault.section_get("notification_attachments", str(nid))
    assert att["key"] == "users/a/workloads/20/first-frame.jpg" and att["name"] == "first-frame.jpg"
    assert att["at"]  # timestamped so housekeeping can drop it
    assert storage.presign_get(att["key"]).endswith("first-frame.jpg")


async def _value(v):
    return v


async def test_a_split_render_that_fails_part_way_leaves_nothing_approved(app):
    app.settings.max_concurrent_instances = 6
    desktop(app)
    app.store.update_workload_plan = None  # never reached: the third part fails first
    launched = []
    app.supervisor.launch = lambda w: launched.append(w)
    intent = Intent(kind="render", summary="animation", render_frames=10, render_machines=4)
    farm = await app.propose(ALICE, 1, intent, render_from=11, auto_approve=False)
    create, made = app.store.create_workload, []

    async def flaky_create(**w):
        if len(made) == 2:
            raise RuntimeError("database unavailable")
        made.append(w["id"])
        await create(**w)

    app.store.create_workload = flaky_create
    with pytest.raises(ActionError, match="split render"):
        await app.approve(ALICE, farm["workload_id"])
    assert launched == []
    # The parts made so far are cancelled, so none holds a concurrency slot; the plan can be retried.
    assert [app.store.rows[i]["status"] for i in made] == ["cancelled", "cancelled"]
    assert app.store.rows[farm["workload_id"]]["status"] == "planned"
    assert (await app.spend_snapshot(ALICE)).active_instances == 1  # just the desktop
