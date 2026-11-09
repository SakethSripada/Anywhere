"""Taking over from, stopping and handing back to the desktop agent, end to end through the core."""

import asyncio
import json
from contextlib import asynccontextmanager

import pytest
from langchain_core.messages import AIMessage

import anywhere.core as core_module
from anywhere.config import ProvisioningMode, Settings
from anywhere.core import Anywhere
from anywhere.operator import PAUSED
from anywhere.stdb import SpacetimeClient
from anywhere.storage import Storage
from anywhere.vault import Vault

from .fakes import FakeBrev
from .test_mcp import ALICE, McpStore
from .test_operator import FakeScreen


class RunStore(McpStore):
    async def start_agent_run(self, id, workload_id, goal):
        self.runs.append(
            {"id": id, "workloadId": workload_id, "goal": goal, "status": "running", "result": "", "startedAt": id}
        )

    async def add_agent_step(self, run_id, kind, summary, detail, key):
        self.steps.append({"runId": run_id, "kind": kind, "summary": summary, "detail": detail})

    async def finish_agent_run(self, id, status, result):
        await asyncio.sleep(0.05)  # a real reducer call takes a round trip
        run = next(r for r in self.runs if r["id"] == id)
        run.update(status=status, result=result)


class SlowLLM:
    """Clicks forever, slowly, so the run is mid-flight when the user acts."""

    def __init__(self):
        self.calls = 0

    async def ainvoke(self, messages):
        self.calls += 1
        await asyncio.sleep(0.01)
        return AIMessage(content=json.dumps({"action": "click", "x": 10 + self.calls, "y": 10}))


@pytest.fixture
def app(tmp_path, monkeypatch):
    settings = Settings(_env_file=None, data_dir=tmp_path, spacetime_worker_token="w")
    store = RunStore()
    a = Anywhere(
        settings=settings,
        store=store,
        public_stdb=SpacetimeClient("http://127.0.0.1:1", "anywhere"),
        brev=FakeBrev(mode=ProvisioningMode.LIVE),
        storage=Storage(settings),
        vault=Vault(tmp_path / "vault.json"),
    )
    store.add(id=11, owner=ALICE, kind="desktop", status="running", conversationId=1, controller="agent")
    screen = FakeScreen()

    @asynccontextmanager
    async def connect(remote, token):
        yield screen

    monkeypatch.setattr(core_module, "connect_screen", connect)
    monkeypatch.setattr(core_module.llm, "vision", lambda settings: SlowLLM())
    a.supervisor.remote = lambda w: None
    return a


async def until(cond, timeout=2.0):
    for _ in range(int(timeout / 0.01)):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition never became true")


async def test_taking_over_pauses_the_run_and_handing_back_resumes_the_goal(app):
    store = app.store
    run_id = await app.operate(ALICE, 11, "Add a cube")
    await until(lambda: any(s["kind"] == "act" for s in store.steps))

    await app.halt_agent(ALICE, 11, pause=True)
    assert store.rows[11]["controller"] == "user"
    assert not app.supervisor.agent_running(11)
    run = next(r for r in store.runs if r["id"] == run_id)
    # Paused, not failed: the UI offers "Hand back" only for a paused run.
    assert run["status"] == "paused" and run["result"] == PAUSED

    resumed = await app.resume_agent(ALICE, 11)
    assert resumed and resumed != run_id
    assert store.rows[11]["controller"] == "agent"
    await until(lambda: any(r["id"] == resumed for r in store.runs))
    await app.halt_agent(ALICE, 11)
    assert next(r for r in store.runs if r["id"] == resumed)["status"] == "stopped"


async def test_a_run_cancelled_by_the_machine_stopping_is_not_reported_as_a_failure(app):
    store = app.store
    run_id = await app.operate(ALICE, 11, "Add a cube")
    await until(lambda: any(s["kind"] == "act" for s in store.steps))
    await app.supervisor.stop_agent(11)
    run = next(r for r in store.runs if r["id"] == run_id)
    assert run["status"] == "stopped" and run["result"] == ""
    assert not [m for m in store.messages if m["kind"] == "agent"]


async def test_steering_from_chat_replaces_the_task_and_stop_keeps_the_machine_on(app):
    from anywhere.agent import TurnContext, _tools

    store = app.store
    store.conversations[1] = {"owner": ALICE}
    tools = {t.name: t for t in _tools(app, TurnContext(owner=ALICE, conversation_id=1, channel="web"))}

    first = json.loads(await tools["operate_desktop"].ainvoke({"workload_id": 11, "goal": "Add a cube"}))
    await until(lambda: any(r["id"] == first["run_id"] for r in store.runs))
    # Calling it again in the same turn doesn't restart the run.
    again = json.loads(await tools["operate_desktop"].ainvoke({"workload_id": 11, "goal": "Add a cube"}))
    assert again["run_id"] == str(first["run_id"])
    assert next(r for r in store.runs if r["id"] == first["run_id"])["status"] == "running"
    # The user steering is a new turn.
    tools = {t.name: t for t in _tools(app, TurnContext(owner=ALICE, conversation_id=1, channel="web"))}
    second = json.loads(await tools["operate_desktop"].ainvoke({"workload_id": 11, "goal": "Add a red cube"}))
    assert second["ok"] and second["run_id"] != first["run_id"]
    assert next(r for r in store.runs if r["id"] == first["run_id"])["status"] == "stopped"
    assert not [m for m in store.messages if m["kind"] == "agent"]  # replacing isn't news

    await until(lambda: any(r["id"] == second["run_id"] for r in store.runs))
    stopped = json.loads(await tools["stop_desktop_agent"].ainvoke({"workload_id": 11}))
    assert stopped["ok"] and not app.supervisor.agent_running(11)
    assert store.rows[11]["status"] == "running" and store.rows[11]["controller"] == "user"


async def test_two_stops_at_once_still_record_how_the_run_ended(app):
    store = app.store
    run_id = await app.operate(ALICE, 11, "Add a cube")
    await until(lambda: any(s["kind"] == "act" for s in store.steps))

    async def second_click():
        await asyncio.sleep(0.01)  # lands while the run is recording how it ended
        await app.halt_agent(ALICE, 11, pause=True)

    await asyncio.gather(app.halt_agent(ALICE, 11, pause=True), second_click())
    assert next(r for r in store.runs if r["id"] == run_id)["status"] == "paused"


async def test_the_agent_does_not_take_the_controls_from_the_user(app):
    from anywhere.agent import TurnContext, _tools
    from anywhere.core import ActionError

    store = app.store
    store.rows[11]["controller"] = "user"
    with pytest.raises(ActionError, match="user has the controls"):
        await app.operate(ALICE, 11, "Add a cube")
    assert not app.supervisor.agent_running(11) and store.rows[11]["controller"] == "user"

    store.conversations[1] = {"owner": ALICE}
    ctx = TurnContext(owner=ALICE, conversation_id=1, channel="imessage", user_text="add a cube")
    tools = {t.name: t for t in _tools(app, ctx)}
    refused = json.loads(await tools["operate_desktop"].ainvoke({"workload_id": 11, "goal": "Add a cube"}))
    assert not refused["ok"] and "hand back" in refused["message"]

    # The user's own plain yes this turn takes them back.
    ctx = TurnContext(owner=ALICE, conversation_id=1, channel="imessage", user_text="Yes, go ahead")
    tools = {t.name: t for t in _tools(app, ctx)}
    started = json.loads(await tools["operate_desktop"].ainvoke({"workload_id": 11, "goal": "Add a cube"}))
    assert started["ok"] and store.rows[11]["controller"] == "agent"
    await app.halt_agent(ALICE, 11)


async def test_handing_back_after_a_finished_run_does_not_redo_it(app, monkeypatch):
    class DoneLLM:
        async def ainvoke(self, messages):
            return AIMessage(content=json.dumps({"action": "done", "text": "Added"}))

    monkeypatch.setattr(core_module.llm, "vision", lambda settings: DoneLLM())
    store = app.store
    run_id = await app.operate(ALICE, 11, "Add a cube")
    await until(lambda: next((r for r in store.runs if r["id"] == run_id), {}).get("status") == "done")
    await until(lambda: not app.supervisor.agent_running(11))
    assert not app.vault.get(11).get("last_goal")
    store.rows[11]["controller"] = "user"
    assert await app.resume_agent(ALICE, 11) is None
    assert store.rows[11]["controller"] == "agent" and len(store.runs) == 1
