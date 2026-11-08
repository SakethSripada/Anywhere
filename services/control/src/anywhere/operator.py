"""The computer-use operator: Nemotron driving a real desktop through Cua.

A small LangGraph loop — observe → decide → act — that works across
applications rather than being scripted for one. Each turn the vision model
sees a fresh screenshot plus a compact history and returns a single typed
action. Before every action we re-check who holds the controls, so a human
can take over mid-task and hand back later; the run pauses rather than fights.

Shell commands run inside the user's isolated desktop container through Cua,
never on the control plane, and pass a coarse safety screen first.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from typing import Literal, TypedDict

import structlog
from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, Field, field_validator, model_validator

from .desktop import Frame, Screen, prepare_frame
from .llm import ModelUnavailable, ainvoke_json

log = structlog.get_logger()

MAX_STEPS = 40
MAX_NOTCHES = 10
#: The same click, typing or command chosen this many times in a row means the agent is stuck.
MAX_REPEATS = 3
MAX_REPEATS_LONG = 8
#: Consecutive actions the desktop failed to perform before giving up.
MAX_ERRORS = 3

#: What the operator says when the user takes the controls mid-task.
PAUSED = "You took control. I'll pick up when you hand it back."

SYSTEM = """You are Anywhere's desktop operator. You control a real Linux (XFCE) desktop \
by looking at screenshots and choosing ONE action at a time.

Environment:
- Blender is installed (`blender`). Projects live in ~/Projects, which is saved \
persistently; save work there.
- A shell runs inside this desktop. Use it for file operations and to launch apps, e.g. \
`nohup blender >/tmp/blender.log 2>&1 &`. Prefer the GUI for anything the user should see happen.

How to work:
- Look carefully at the latest screenshot before acting. Give coordinates on a 0-1000 grid \
over that screenshot: (0, 0) is the top-left corner and (1000, 1000) the bottom-right, \
whatever its pixel size ({width}x{height}).
- Prefer reliable keyboard shortcuts when an application supports them.
- To scroll, give the point to scroll at and "dy" in wheel notches: positive scrolls down, \
negative scrolls up, at most 10 at a time.
- After an action, verify its effect on the next screenshot before moving on. If something \
didn't work, try a different approach instead of repeating it.
- When the goal is achieved and visibly verified, return action "done" with a short summary \
of what you did. If it is impossible, return "fail" with the reason.

Reply with ONLY a JSON object:
{{"thought": "<one sentence on what you see and why this action>",
  "summary": "<a few words for the user, e.g. 'Opening the Add menu'>",
  "action": "click|double_click|right_click|move|drag|type|key|scroll|shell|wait|done|fail",
  "x": int, "y": int, "x2": int, "y2": int,
  "text": "<text to type, or result for done/fail>",
  "keys": ["ctrl","s"], "dy": int, "command": "<shell command>"}}
Include only the fields the action needs."""

ActionName = Literal[
    "click", "double_click", "right_click", "move", "drag", "type", "key", "scroll", "shell", "wait", "done", "fail"
]

#: Names vision models commonly use for the same actions.
_ACTION_ALIASES = {
    "left_click": "click",
    "doubleclick": "double_click",
    "rightclick": "right_click",
    "mouse_move": "move",
    "hover": "move",
    "hotkey": "key",
    "keypress": "key",
    "press": "key",
    "key_press": "key",
    "type_text": "type",
    "finish": "done",
    "finished": "done",
}


class Action(BaseModel):
    thought: str = ""
    summary: str = Field(default="", max_length=120)
    action: ActionName
    x: int | None = None
    y: int | None = None
    x2: int | None = None
    y2: int | None = None
    text: str | None = None
    keys: list[str] | None = None
    dy: int | None = None
    command: str | None = None

    @field_validator("summary", mode="before")
    @classmethod
    def _short_summary(cls, v: object) -> object:
        # A wordy label is not worth a repair round trip (or, twice, the whole run).
        return v[:120] if isinstance(v, str) else v

    @field_validator("action", mode="before")
    @classmethod
    def _known_action(cls, v: object) -> object:
        if isinstance(v, str):
            name = v.strip().lower().replace("-", "_").replace(" ", "_")
            return _ACTION_ALIASES.get(name, name)
        return v

    @model_validator(mode="after")
    def _fields_for_action(self) -> Action:
        needs_xy = {"click", "double_click", "right_click", "move", "drag", "scroll"}
        if self.action in needs_xy and (self.x is None or self.y is None):
            raise ValueError(f"{self.action} requires x and y")
        if self.action == "drag" and (self.x2 is None or self.y2 is None):
            raise ValueError("drag requires x2 and y2")
        if self.action == "type" and not self.text:
            raise ValueError("type requires text")
        if self.action == "key" and not self.keys:
            raise ValueError("key requires keys")
        if self.action == "shell" and not self.command:
            raise ValueError("shell requires command")
        return self


# Coarse guard for obviously destructive commands. Execution is already isolated
# to the user's own container; this catches accidents, not adversaries.
_BLOCKED = re.compile(
    r"(\brm\s+-[a-z]*r[a-z]*f?\s+(/|~|\$HOME)(\s|$)|\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b|"
    r":\(\)\s*\{|\bchmod\s+-R\s+777\s+/|curl[^|]*\|\s*(sudo\s+)?(ba)?sh)"
)


def command_allowed(command: str) -> bool:
    return not _BLOCKED.search(command)


class OpState(TypedDict, total=False):
    goal: str
    step: int
    history: list[str]
    frame_url: str
    frame_meta: dict
    jpeg: bytes
    action: dict
    outcome: str
    status: str  # running | paused | done | failed
    result: str
    last_sig: str  # the previous action, to notice the model repeating itself
    repeats: int  # how many times in a row that action has been chosen
    errors: int  # consecutive actions the desktop failed to perform


StepSink = Callable[[str, str, str, bytes | None], Awaitable[None]]
ControlCheck = Callable[[], Awaitable[bool]]


def build_operator(*, llm, screen: Screen, record: StepSink, has_control: ControlCheck, max_steps: int = MAX_STEPS):
    """Compile the operator graph for one desktop session."""

    async def observe(state: OpState) -> OpState:
        if not await has_control():
            return {"status": "paused", "result": PAUSED}
        png = await screen.screenshot()
        # PIL resize + JPEG encode takes ~50-150 ms; off the loop so it can't stall
        # the VNC relay or other requests.
        frame = await asyncio.to_thread(prepare_frame, png)
        return {
            "frame_url": frame.data_url,
            "frame_meta": {"w": frame.width, "h": frame.height, "scale": frame.scale},
            "status": "running",
            "jpeg": frame.jpeg,
        }

    async def decide(state: OpState) -> OpState:
        meta = state["frame_meta"]
        recent = "\n".join(f"{i + 1}. {h}" for i, h in enumerate(state.get("history", [])[-12:])) or "(none yet)"
        messages = [
            SystemMessage(SYSTEM.format(width=meta["w"], height=meta["h"])),
            HumanMessage(
                content=[
                    {
                        "type": "text",
                        "text": f"Goal: {state['goal']}\n\nSteps so far:\n{recent}\n\n"
                        f"Last outcome: {state.get('outcome', 'n/a')}\n\nStep {state.get('step', 0) + 1} of {max_steps}.",
                    },
                    {"type": "image_url", "image_url": {"url": state["frame_url"]}},
                ]
            ),
        ]
        action = await ainvoke_json(llm, messages, Action, retries=1)
        return {"action": action.model_dump()}

    async def act(state: OpState) -> OpState:
        meta = state["frame_meta"]
        action = _on_screen(
            _from_grid(Action.model_validate(state["action"]), meta["w"], meta["h"]), meta["w"], meta["h"]
        )
        frame = Frame(jpeg=b"", width=meta["w"], height=meta["h"], scale=meta["scale"])
        step = state.get("step", 0) + 1
        label = action.summary or action.action.replace("_", " ")

        if action.action in ("done", "fail"):
            await record("done" if action.action == "done" else "error", label, action.text or "", None)
            return {
                "status": "done" if action.action == "done" else "failed",
                "result": action.text or label,
                "step": step,
            }

        # Stuck: the same action chosen again and again. Stop rather than spend model
        # calls until the step limit. Keys, scrolls and waits legitimately repeat more.
        sig = json.dumps(_public(action), sort_keys=True)
        repeats = state.get("repeats", 0) + 1 if sig == state.get("last_sig") else 1
        if repeats > (MAX_REPEATS_LONG if action.action in ("key", "scroll", "wait") else MAX_REPEATS):
            result = (
                f"I kept trying the same thing ({label}) without getting anywhere, so I stopped. "
                "Take over, or tell me what to try instead."
            )
            await record("error", "Stopped: repeating the same action", result, None)
            return {"status": "failed", "result": result, "step": step}

        if not await has_control():
            return {"status": "paused", "result": PAUSED}

        outcome = "ok"
        errors = 0
        try:
            outcome = await _execute(screen, action, frame)
        except Exception as exc:  # surfaced to the model so it can recover
            outcome = f"error: {exc}"
            errors = state.get("errors", 0) + 1
            log.warning("operator.action_failed", action=action.action, error=str(exc))

        await record(
            "act",
            label,
            json.dumps(
                {
                    "thought": action.thought,
                    **_public(action),
                    "outcome": outcome[:500],
                    # Coordinates are in screenshot space; the browser maps them onto the stream.
                    "frame": [meta["w"], meta["h"]],
                }
            ),
            None,
        )
        history = [*state.get("history", []), f"{label} → {outcome[:160]}"]
        status = "running" if step < max_steps else "failed"
        result = "" if status == "running" else f"Stopped after {max_steps} steps without finishing."
        if errors >= MAX_ERRORS:
            status = "failed"
            result = f"The desktop stopped responding to my actions, so I stopped. Last error: {outcome[7:300]}"
        return {
            "history": history,
            "outcome": outcome,
            "step": step,
            "status": status,
            "result": result,
            "last_sig": sig,
            "repeats": repeats,
            "errors": errors,
        }

    async def snapshot(state: OpState) -> OpState:
        # Persist the frame the decision was made on, so the timeline shows what the agent saw.
        jpeg = state.get("jpeg")
        if jpeg:
            await record("observe", "Looked at the screen", "", jpeg)
        return {}

    def after_observe(state: OpState) -> str:
        return END if state.get("status") == "paused" else "snapshot"

    def after_act(state: OpState) -> str:
        return "observe" if state.get("status") == "running" else END

    g = StateGraph(OpState)
    g.add_node("observe", observe)
    g.add_node("snapshot", snapshot)
    g.add_node("decide", decide)
    g.add_node("act", act)
    g.add_edge(START, "observe")
    g.add_conditional_edges("observe", after_observe, ["snapshot", END])
    g.add_edge("snapshot", "decide")
    g.add_edge("decide", "act")
    g.add_conditional_edges("act", after_act, ["observe", END])
    return g.compile()


def describe_failure(exc: Exception) -> str:
    """What to tell the user when a run crashes, without a raw traceback or validation dump."""
    if isinstance(exc, ModelUnavailable):
        return "The vision model isn't set up on this server, so I can't operate the desktop."
    text = str(exc)
    if text.startswith("Model did not produce valid output"):
        return (
            "The vision model kept replying in a form I couldn't act on, so I stopped. Try again or rephrase the task."
        )
    first = text.strip().splitlines()[0][:300] if text.strip() else exc.__class__.__name__
    return f"I hit a problem operating the desktop: {first}"


#: The model answers on a 0-1000 grid. Nemotron VL does so regardless of what it's told:
#: on a live run it aimed at Blender's Add menu (267, 88 in a 1280x800 frame) with
#: (214, 112), which is that point on the grid, and looped clicking just below it.
GRID = 1000


def _from_grid(action: Action, width: int, height: int) -> Action:
    """Grid coordinates to screenshot pixels."""

    def px(v: int | None, size: int) -> int | None:
        return None if v is None else round(v * (size - 1) / GRID)

    return action.model_copy(
        update={
            "x": px(action.x, width),
            "y": px(action.y, height),
            "x2": px(action.x2, width),
            "y2": px(action.y2, height),
        }
    )


def _on_screen(action: Action, width: int, height: int) -> Action:
    """Clamp coordinates into the screenshot. A point just off the edge would otherwise
    land outside the desktop (or fail in Cua) and draw the cursor off the stream."""

    def clamp(v: int | None, size: int) -> int | None:
        return None if v is None else max(0, min(size - 1, v))

    return action.model_copy(
        update={
            "x": clamp(action.x, width),
            "y": clamp(action.y, height),
            "x2": clamp(action.x2, width),
            "y2": clamp(action.y2, height),
        }
    )


def _public(action: Action) -> dict:
    return {k: v for k, v in action.model_dump().items() if v is not None and k not in ("thought", "summary")}


async def _execute(screen: Screen, a: Action, frame: Frame) -> str:
    def xy(x: int | None, y: int | None) -> tuple[int, int]:
        return frame.to_screen(x or 0, y or 0)

    match a.action:
        case "click":
            await screen.click(*xy(a.x, a.y))
        case "double_click":
            await screen.click(*xy(a.x, a.y), double=True)
        case "right_click":
            await screen.click(*xy(a.x, a.y), button="right")
        case "move":
            await screen.move(*xy(a.x, a.y))
        case "drag":
            await screen.drag(*xy(a.x, a.y), *xy(a.x2, a.y2))
        case "scroll":
            # The model gives notches with positive meaning down; Cua's wheel scrolls up for
            # positive values. Clamp so a pixel-sized number can't spin hundreds of notches.
            notches = max(-MAX_NOTCHES, min(MAX_NOTCHES, a.dy or 3))
            await screen.scroll(*xy(a.x, a.y), -notches)
        case "type":
            await screen.type(a.text or "")
        case "key":
            await screen.keys([k.lower() for k in a.keys or []])
        case "shell":
            command = a.command or ""
            if not command_allowed(command):
                return "refused: that command could destroy data; choose a safer approach"
            code, out = await screen.shell(command, timeout=60)
            return f"exit {code}: {out.strip()[-400:]}" if out.strip() else f"exit {code}"
        case "wait":
            await asyncio.sleep(2)
    # Give the UI a moment to settle before the next screenshot.
    await asyncio.sleep(0.6)
    return "ok"
