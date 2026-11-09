"""Model calls: retries on transient failures, and lean repair turns."""

import json

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from pydantic import BaseModel

import anywhere.llm as llm


class Reply(BaseModel):
    answer: int


class Flaky:
    def __init__(self, failures, reply='{"answer": 1}'):
        self.failures = list(failures)
        self.reply = reply
        self.seen = []

    async def ainvoke(self, messages):
        self.seen.append(messages)
        if self.failures:
            raise self.failures.pop(0)
        return AIMessage(content=self.reply)


@pytest.fixture(autouse=True)
def no_backoff(monkeypatch):
    monkeypatch.setattr(llm, "RETRY_DELAY", 0.0)


async def test_timeouts_429s_and_5xx_are_retried():
    model = Flaky(
        [
            TimeoutError(),
            Exception("[429] Too Many Requests"),
        ]
    )
    assert (await llm.ainvoke(model, [])).content == '{"answer": 1}'
    assert len(model.seen) == 3
    model = Flaky([Exception("[502] Bad Gateway")] * 3)
    with pytest.raises(Exception, match="502"):
        await llm.ainvoke(model, [])
    assert len(model.seen) == llm.ATTEMPTS


async def test_client_errors_are_not_retried():
    model = Flaky([Exception("[400] Bad Request")])
    with pytest.raises(Exception, match="400"):
        await llm.ainvoke(model, [])
    assert len(model.seen) == 1


async def test_a_repair_turn_does_not_resend_the_screenshot():
    class Once(Flaky):
        async def ainvoke(self, messages):
            self.seen.append(messages)
            return AIMessage(content="nope" if len(self.seen) == 1 else json.dumps({"answer": 2}))

    model = Once([])
    shot = {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AAAA"}}
    first = [HumanMessage(content=[{"type": "text", "text": "Goal"}, shot])]
    assert (await llm.ainvoke_json(model, first, Reply)).answer == 2
    repair = model.seen[1]
    assert not any(isinstance(p, dict) and p.get("type") == "image_url" for m in repair for p in m.content or [])
    assert first[0].content[1]["type"] == "image_url"  # the caller's messages are left alone


def test_model_calls_wait_longer_than_the_library_default():
    from anywhere.config import Settings

    settings = Settings(_env_file=None, nvidia_api_key="test")
    assert llm.planner(settings)._client.timeout == llm.TIMEOUT >= 180
