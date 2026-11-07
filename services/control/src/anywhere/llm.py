"""Nemotron model factories (NVIDIA API Catalog, OpenAI-compatible)."""

from __future__ import annotations

import json
import re
from typing import TypeVar

from langchain_core.messages import BaseMessage, HumanMessage
from langchain_nvidia_ai_endpoints import ChatNVIDIA
from pydantic import BaseModel, ValidationError

from .config import Settings

T = TypeVar("T", bound=BaseModel)


class ModelUnavailable(Exception):
    pass


def _key(settings: Settings) -> str:
    if not settings.nvidia_api_key:
        raise ModelUnavailable("NVIDIA_API_KEY is not configured")
    return settings.nvidia_api_key.get_secret_value()


def planner(settings: Settings) -> ChatNVIDIA:
    """Nemotron 3 Super: the central agent. Tool calling + multi-step reasoning."""
    return ChatNVIDIA(
        model=settings.planner_model,
        api_key=_key(settings),
        base_url=settings.nvidia_base_url,
        temperature=0.6,
        top_p=0.95,
        max_completion_tokens=4096,
    )


def vision(settings: Settings) -> ChatNVIDIA:
    """Nemotron 3 Nano Omni: reads screenshots and grounds GUI actions."""
    return ChatNVIDIA(
        model=settings.vision_model,
        api_key=_key(settings),
        base_url=settings.nvidia_base_url,
        temperature=0.2,
        max_completion_tokens=2048,
    )


_JSON_BLOCK = re.compile(r"\{.*\}", re.DOTALL)


def parse_json_model(text: str, model: type[T]) -> T:
    """Extract and validate the last JSON object in a model reply."""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
    match = _JSON_BLOCK.search(text)
    if not match:
        raise ValueError("No JSON object in reply")
    return model.model_validate(json.loads(match.group(0)))


async def ainvoke_json(llm: ChatNVIDIA, messages: list[BaseMessage], model: type[T], retries: int = 1) -> T:
    """Ask for JSON, validate it, and give the model one chance to repair errors."""
    history = list(messages)
    last_error: Exception | None = None
    for _ in range(retries + 1):
        reply = await llm.ainvoke(history)
        content = reply.content if isinstance(reply.content, str) else json.dumps(reply.content)
        try:
            return parse_json_model(content, model)
        except (ValueError, ValidationError) as exc:
            last_error = exc
            history += [
                reply,
                HumanMessage(f"That reply was invalid ({exc}). Reply with only the corrected JSON object."),
            ]
    raise ValueError(f"Model did not produce valid output: {last_error}")
