"""Tool calls are mirrored into the conversation as tool_call / tool_result pairs."""

import json
from types import SimpleNamespace

import pytest
from langchain_core.tools import StructuredTool
from pydantic import BaseModel

from anywhere.agent import TurnContext, _failed, _recorded


class Store:
    def __init__(self, fail: bool = False):
        self.messages: list[tuple] = []
        self.fail = fail

    async def append_message(self, cid, role, kind, body, workload_id, channel):
        if self.fail:
            raise RuntimeError("spacetime down")
        self.messages.append((cid, role, kind, json.loads(body), workload_id, channel))


class Args(BaseModel):
    workload_id: int


def tool(fn):
    return StructuredTool.from_function(coroutine=fn, name="stop_workload", description="d", args_schema=Args)


@pytest.mark.asyncio
async def test_records_call_and_result_with_shared_id():
    store = Store()

    async def stop(workload_id: int) -> str:
        return "Stopping."

    wrapped = _recorded(SimpleNamespace(store=store), TurnContext("o", 7, "web"), tool(stop))
    assert await wrapped.ainvoke({"workload_id": 42}) == "Stopping."

    (_, _, k1, call, w1, _), (_, _, k2, result, w2, _) = store.messages
    assert (k1, k2) == ("tool_call", "tool_result")
    assert call["call_id"] == result["call_id"]
    assert call["args"] == {"workload_id": 42} and w1 == w2 == 42
    assert result["ok"] is True and result["output"] == "Stopping."


@pytest.mark.asyncio
async def test_failures_are_reported_not_raised():
    store = Store()

    async def boom(workload_id: int) -> str:
        raise ValueError("nope")

    wrapped = _recorded(SimpleNamespace(store=store), TurnContext("o", 7, "web"), tool(boom))
    out = await wrapped.ainvoke({"workload_id": 1})
    assert out.startswith("Tool failed")
    assert store.messages[-1][3]["ok"] is False


@pytest.mark.asyncio
async def test_recording_outage_does_not_break_the_turn():
    async def stop(workload_id: int) -> str:
        return "ok"

    wrapped = _recorded(SimpleNamespace(store=Store(fail=True)), TurnContext("o", 7, "web"), tool(stop))
    assert await wrapped.ainvoke({"workload_id": 1}) == "ok"


def test_failure_detection():
    assert _failed(json.dumps({"ok": False, "message": "x"}))
    assert not _failed(json.dumps({"ok": True}))
    assert _failed("Could not approve: already running")
    assert not _failed("Approved.")
