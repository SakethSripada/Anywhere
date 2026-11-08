"""The demo loop over iMessage: a task texted in is texted back when done, progress
updates arrive on a schedule, and "send me a pic" returns a screenshot with the reply."""

import asyncio
import json
from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage

import anywhere.core as core_module
from anywhere.agent import TurnContext, _tools

from .test_mcp import ALICE
from .test_operator_control import RunStore, SlowLLM, app, until  # noqa: F401  (fixture)

PHONE = "+15550100199"


class PhoneStore(RunStore):
    def __init__(self):
        super().__init__()
        self.texts: list[tuple[str, str]] = []

    async def handles_for(self, owner):
        return [PHONE] if owner == ALICE else []

    async def enqueue_notification(self, id, owner, channel, handle, body):
        self.texts.append((handle, body))


class DoneLLM:
    """Clicks once, then says it's done."""

    def __init__(self):
        self.calls = 0

    async def ainvoke(self, messages):
        self.calls += 1
        await asyncio.sleep(0.01)
        if self.calls == 1:
            return AIMessage(content=json.dumps({"action": "click", "x": 500, "y": 500}))
        return AIMessage(content=json.dumps({"action": "done", "text": "Added a red cube at the origin."}))


@pytest.fixture
def phone_app(app, monkeypatch):  # noqa: F811
    store = PhoneStore()
    store.rows, store.conversations = app.store.rows, app.store.conversations
    app.store = store
    app.supervisor.store = store
    return app


async def test_a_task_texted_in_is_texted_back_when_done(phone_app, monkeypatch):
    monkeypatch.setattr(core_module.llm, "vision", lambda settings: DoneLLM())
    run_id = await phone_app.operate(ALICE, 11, "Add a red cube", channel="imessage")
    await until(lambda: any(r["id"] == run_id and r["status"] == "done" for r in phone_app.store.runs), 5)
    await until(lambda: phone_app.store.texts, 2)
    handle, body = phone_app.store.texts[-1]
    assert handle == PHONE and body.startswith("Done on") and "red cube" in body


async def test_a_task_from_the_web_does_not_text(phone_app, monkeypatch):
    monkeypatch.setattr(core_module.llm, "vision", lambda settings: DoneLLM())
    run_id = await phone_app.operate(ALICE, 11, "Add a red cube")
    await until(lambda: any(r["id"] == run_id and r["status"] == "done" for r in phone_app.store.runs), 5)
    await asyncio.sleep(0.1)
    assert phone_app.store.texts == []


async def test_progress_updates_arrive_while_the_agent_works_and_stop_with_it(phone_app):
    phone_app.UPDATE_TICK, phone_app.UPDATE_MINUTE = 0.02, 0.05
    phone_app.set_progress_updates(11, 1)
    await phone_app.operate(ALICE, 11, "Model a city block", channel="imessage")
    await until(lambda: len(phone_app.store.texts) >= 2, 3)
    assert all(b.startswith("Update on") and "city block" in b for _, b in phone_app.store.texts)

    await phone_app.halt_agent(ALICE, 11)
    sent = len(phone_app.store.texts)
    await asyncio.sleep(0.2)
    # Stopped by the user: no more updates and no "done" text.
    assert len(phone_app.store.texts) == sent


async def test_send_screenshot_attaches_a_picture_to_the_reply(phone_app):
    phone_app.supervisor.shots = SimpleNamespace(frame=_frame)
    phone_app.vault.agent_token = lambda wid: "t"
    ctx = TurnContext(owner=ALICE, conversation_id=1, channel="imessage")
    tools = {t.name: t for t in _tools(phone_app, ctx)}
    out = json.loads(await tools["send_screenshot"].ainvoke({"workload_id": 11}))
    assert out["ok"] and ctx.attachments == [b"\xff\xd8jpeg"]

    web = {t.name for t in _tools(phone_app, TurnContext(owner=ALICE, conversation_id=1, channel="web"))}
    assert "send_screenshot" not in web and "set_progress_updates" in web


async def test_progress_questions_see_the_current_steps(phone_app):
    phone_app.store.agent_step_summaries = _steps(phone_app.store)
    await phone_app.operate(ALICE, 11, "Model a city block", channel="imessage")
    await until(lambda: any(s["kind"] == "act" for s in phone_app.store.steps))
    phone_app.store.telemetry = _telemetry(phone_app.store)
    phone_app.store.rows[11].update(
        title="Blender desktop", statusDetail="", gpuName="L40S", accruedCents=40, estLowCents=100, estHighCents=200
    )
    tools = {t.name: t for t in _tools(phone_app, TurnContext(owner=ALICE, conversation_id=1, channel="imessage"))}
    info = json.loads(await tools["inspect_workload"].ainvoke({"workload_id": 11}))
    assert info["agent_working_now"] and info["current_steps"]
    await phone_app.halt_agent(ALICE, 11)


async def _frame(workload_id, remote, token):
    return SimpleNamespace(jpeg=b"\xff\xd8jpeg")


def _steps(store):
    async def summaries(run_id):
        return [{"seq": i, **s} for i, s in enumerate(store.steps) if s["runId"] == run_id]

    return summaries


def _telemetry(store):
    async def telemetry(workload_id):
        return {"logs": [], "metrics": [], "events": [], "artifacts": [], "agent_runs": list(store.runs)}

    return telemetry
