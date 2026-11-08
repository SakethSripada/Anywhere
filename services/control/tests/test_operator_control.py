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
    store.add(id=11, owner=ALICE, kind="desktop", status="running", conversationId=1, controller="user")
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
