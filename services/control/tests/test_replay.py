"""Agent replays: pairing screenshots with actions, the timelapse GIF, and access rules."""

import io
import json

import pytest
from PIL import Image

from anywhere.config import ProvisioningMode, Settings
from anywhere.core import ActionError, Anywhere
from anywhere.replay import frames_from_steps, timelapse_gif
from anywhere.stdb import SpacetimeClient
from anywhere.storage import Storage
from anywhere.vault import Vault

from .fakes import FakeBrev
from .test_mcp import ALICE, BOB, McpStore, account


def jpeg(color=(40, 90, 160), size=(1280, 720)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="JPEG")
    return buf.getvalue()


def act(seq, summary, action="click", x=100, y=50, **extra):
    detail = {"thought": f"because {summary}", "action": action, "x": x, "y": y, "frame": [1280, 720], **extra}
    return {"seq": seq, "kind": "act", "summary": summary, "detail": json.dumps(detail), "screenshotKey": ""}


def observe(seq, key):
    return {"seq": seq, "kind": "observe", "summary": "Looked at the screen", "detail": "", "screenshotKey": key}


STEPS = [
    observe(1, f"users/{ALICE}/workloads/11/agent-7-001.jpg"),
    act(2, "Open the Add menu"),
    observe(3, f"users/{ALICE}/workloads/11/agent-7-002.jpg"),
    act(4, "Drag the sphere", action="drag", x=10, y=20, x2=300, y2=400),
    observe(5, f"users/{ALICE}/workloads/11/agent-7-003.jpg"),
    {
        "seq": 6,
        "kind": "done",
        "summary": "UV sphere added",
        "detail": "The sphere is visible next to the cube.",
        "screenshotKey": "",
    },
]


def test_frames_pair_each_screenshot_with_the_action_taken_on_it():
    frames = frames_from_steps(list(reversed(STEPS)))  # order comes from seq, not input order
    assert [f["caption"] for f in frames] == ["Open the Add menu", "Drag the sphere", "UV sphere added"]
    assert frames[0]["point"] == [100, 50] and frames[0]["size"] == [1280, 720]
    assert frames[0]["thought"] == "because Open the Add menu"
    assert frames[1]["point_to"] == [300, 400]
    assert frames[2]["kind"] == "done" and "visible" in frames[2]["thought"]
    # Typing has no pointer, and a screenshot nobody acted on still shows.
    typed = frames_from_steps(
        [observe(1, "k1"), act(2, "Type the name", action="type", x=None, y=None), observe(3, "k2")]
    )
    assert "point" not in typed[0] and typed[1]["caption"] == "Looked at the screen"


def test_timelapse_is_an_annotated_animated_gif():
    frames = frames_from_steps(STEPS)
    gif = timelapse_gif([jpeg((i * 60, 90, 160)) for i in range(len(frames))], frames, "Add a UV sphere")
    img = Image.open(io.BytesIO(gif))
    assert img.format == "GIF" and img.n_frames == 3 and img.width == 960
    durations = []
    for i in range(img.n_frames):
        img.seek(i)
        durations.append(img.info["duration"])
    assert durations[-1] > durations[0]  # the last frame lingers
    with pytest.raises(ValueError):
        timelapse_gif([], [], "nothing")


class FakeStorage:
    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.gets = 0

    def presign_get(self, key, expires=900, filename=None):
        return f"https://bucket.example/{key}?sig=x"

    async def head(self, key):
        return {"ContentLength": len(self.objects[key])} if key in self.objects else None

    async def get_bytes(self, key):
        self.gets += 1
        return self.objects[key]

    async def put_bytes(self, key, data, content_type):
        self.objects[key] = data


@pytest.fixture
def app(tmp_path):
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        spacetime_worker_token="w",
        s3_bucket="b",
        s3_access_key_id="k",
        s3_secret_access_key="s",
    )
    store = McpStore()
    store.accounts_ = [account(ALICE), account(BOB)]
    store.runs = [
        {
            "id": 7,
            "workloadId": 11,
            "goal": "Add a UV sphere",
            "status": "done",
            "result": "Done",
            "startedAt": None,
            "endedAt": None,
        }
    ]
    store.steps = [dict(s, runId=7) for s in STEPS]
    artifacts = []

    async def add_artifact(*a):
        artifacts.append(a)

    store.add_artifact = add_artifact
    a = Anywhere(
        settings=settings,
        store=store,
        public_stdb=SpacetimeClient("http://127.0.0.1:1", "anywhere"),
        brev=FakeBrev(mode=ProvisioningMode.LIVE),
        storage=Storage(settings),
        vault=Vault(tmp_path / "vault.json"),
    )
    a.storage = FakeStorage()
    for s in STEPS:
        if s["screenshotKey"]:
            a.storage.objects[s["screenshotKey"]] = jpeg()
    store.add(id=11, owner=ALICE, kind="desktop", status="running", conversationId=1)
    store.add(id=12, owner=BOB, kind="desktop", status="running", conversationId=2)
    a.artifacts = artifacts  # type: ignore[attr-defined]
    return a


async def test_replay_returns_signed_frames_for_the_owner_only(app):
    r = await app.replay(ALICE, 11, 7)
    assert r["goal"] == "Add a UV sphere" and len(r["frames"]) == 3
    assert all(f["url"].startswith("https://bucket.example/users/") and "key" not in f for f in r["frames"])
    with pytest.raises(ActionError, match="not found"):
        await app.replay(BOB, 11, 7)  # someone else's machine
    with pytest.raises(ActionError, match="wasn't found"):
        await app.replay(ALICE, 11, 999)


async def test_replay_skips_screenshots_outside_the_owners_storage(app):
    app.store.steps[0]["screenshotKey"] = f"users/{BOB}/workloads/12/agent-1-001.jpg"
    r = await app.replay(ALICE, 11, 7)
    assert len(r["frames"]) == 2


async def test_timelapse_is_rendered_once_and_listed_as_an_output(app):
    first = await app.replay_gif(ALICE, 11, 7)
    assert first["frames"] == 3 and first["url"].endswith("agent-7-timelapse.gif?sig=x")
    gets = app.storage.gets
    again = await app.replay_gif(ALICE, 11, 7)
    assert again["url"] == first["url"] and app.storage.gets == gets  # served from the saved GIF
    assert len(app.artifacts) == 1 and app.artifacts[0][3].endswith("timelapse.gif")


async def test_concurrent_timelapse_requests_render_it_once(app):
    import asyncio

    a, b = await asyncio.gather(app.replay_gif(ALICE, 11, 7), app.replay_gif(ALICE, 11, 7))
    assert a["url"] == b["url"]
    assert len(app.artifacts) == 1  # a double click doesn't build (and list) it twice
    assert app.storage.gets == 3
