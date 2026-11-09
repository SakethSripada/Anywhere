"""Nemotron model factories (NVIDIA API Catalog, OpenAI-compatible)."""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any, TypeVar

import aiohttp
import structlog
from langchain_core.messages import BaseMessage, HumanMessage
from langchain_nvidia_ai_endpoints import ChatNVIDIA
from pydantic import BaseModel, ValidationError

from .config import Settings

T = TypeVar("T", bound=BaseModel)


#: Seconds to wait for a reply. Calls aren't streamed and can spend up to 8192 tokens
#: (reasoning included) before answering, which ran past the library's 60 s default.
TIMEOUT = 180.0
#: Attempts per call on a timeout, 429 or 5xx, with exponential backoff from RETRY_DELAY.
ATTEMPTS = 3
RETRY_DELAY = 2.0

log = structlog.get_logger()


class ModelUnavailable(Exception):
    pass


def transient(exc: BaseException) -> bool:
    """A failure worth retrying: a timeout, a dropped connection, a 429 or a 5xx.

    ChatNVIDIA raises a bare Exception whose message starts "[status] ..." for HTTP errors."""
    if isinstance(exc, (TimeoutError, aiohttp.ClientConnectionError, aiohttp.ServerTimeoutError)):
        return True
    m = re.match(r"\[(\d{3})\]", str(exc).lstrip())
    return bool(m) and (m.group(1) == "429" or m.group(1).startswith("5"))


async def ainvoke(llm: Any, messages: list, *, attempts: int = ATTEMPTS) -> Any:
    """`llm.ainvoke(messages)`, retried with backoff on transient failures."""
    for attempt in range(attempts):
        try:
            return await llm.ainvoke(messages)
        except Exception as exc:
            if attempt == attempts - 1 or not transient(exc):
                raise
            delay = RETRY_DELAY * 2**attempt
            log.warning("llm.retry", attempt=attempt + 1, delay=delay, error=str(exc)[:200])
            await asyncio.sleep(delay)
    raise AssertionError("unreachable")


def _key(settings: Settings) -> str:
    if not settings.nvidia_api_key:
        raise ModelUnavailable("NVIDIA_API_KEY is not configured")
    return settings.nvidia_api_key.get_secret_value()


def planner(settings: Settings) -> ChatNVIDIA:
    """Nemotron 3.5 Super: the central agent. Tool calling + multi-step reasoning.

    Reasoning tokens count against the completion budget, so it is generous;
    a small cap can end the turn before any answer or tool call is produced."""
    return ChatNVIDIA(
        model=settings.planner_model,
        api_key=_key(settings),
        base_url=settings.nvidia_base_url,
        # NVIDIA's model card recommends temperature 1.0 / top_p 0.95 for this
        # reasoning model across all tasks; lower temperatures degrade its reasoning.
        temperature=1.0,
        top_p=0.95,
        max_completion_tokens=8192,
        timeout=TIMEOUT,
    )


def vision(settings: Settings):
    """Nemotron 3.5 Super VL: reads screenshots and grounds GUI actions."""
    model = ChatNVIDIA(
        model=settings.vision_model,
        api_key=_key(settings),
        base_url=settings.nvidia_base_url,
        # NVIDIA's model card for Nemotron 3.5 Super VL recommends temperature 0.6
        # and top_p 0.95 for image input (1.0 / 0.95 for text).
        temperature=0.6,
        top_p=0.95,
        max_completion_tokens=8192,
        timeout=TIMEOUT,
    )
    known = model._client.model  # None for ids missing from the library's model table
    if known is not None and known.supports_thinking:
        return model.with_thinking_mode(enabled=settings.vision_thinking)
    return model


def parse_json_model(text: str, model: type[T]) -> T:
    """Extract and validate the last JSON object in a model reply.

    Decodes object by object rather than first-brace-to-last: a reply that carries code
    (blender_python) often has braces, or a second object, after the one we want."""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
    decoder = json.JSONDecoder(strict=False)  # models put raw newlines inside long strings
    found: list[object] = []
    i = text.find("{")
    while i != -1:
        try:
            obj, end = decoder.raw_decode(text, i)
            found.append(obj)
            i = text.find("{", end)
        except json.JSONDecodeError:
            i = text.find("{", i + 1)
    if not found and "{" in text:
        # Repairs for the slips seen live in long code-carrying replies: Python-style \\'
        # escapes (invalid JSON) and a reply cut off before its closing brace.
        start = text[text.index("{") :].replace("\\'", "'")
        cut = start[: start.rfind('"') + 1]  # drop anything trailing the last string
        for candidate in (start, start + "}", cut + "}"):
            try:
                found.append(decoder.raw_decode(candidate)[0])
                break
            except json.JSONDecodeError:
                continue
    if not found:
        raise ValueError("No JSON object in reply")
    error: ValidationError | None = None
    for obj in reversed(found):
        try:
            return model.model_validate(obj)
        except ValidationError as exc:
            error = error or exc
    raise error


def without_images(messages: list[BaseMessage]) -> list[BaseMessage]:
    """The messages with image parts replaced by a note. A repair turn only fixes the
    reply's format, so resending the screenshot just costs upload time and tokens."""
    out: list[BaseMessage] = []
    for m in messages:
        if isinstance(m.content, list) and any(isinstance(p, dict) and p.get("type") == "image_url" for p in m.content):
            parts = [
                {"type": "text", "text": "(screenshot omitted; it hasn't changed)"}
                if isinstance(p, dict) and p.get("type") == "image_url"
                else p
                for p in m.content
            ]
            m = m.model_copy(update={"content": parts})
        out.append(m)
    return out


async def ainvoke_json(llm: ChatNVIDIA, messages: list[BaseMessage], model: type[T], retries: int = 1) -> T:
    """Ask for JSON, validate it, and give the model one chance to repair errors."""
    history = list(messages)
    last_error: Exception | None = None
    for _ in range(retries + 1):
        reply = await ainvoke(llm, history)
        content = reply.content if isinstance(reply.content, str) else json.dumps(reply.content)
        try:
            return parse_json_model(content, model)
        except (ValueError, ValidationError) as exc:
            last_error = exc
            history = [
                *without_images(history),
                reply,
                HumanMessage(f"That reply was invalid ({exc}). Reply with only the corrected JSON object."),
            ]
    raise ValueError(f"Model did not produce valid output: {last_error}")
