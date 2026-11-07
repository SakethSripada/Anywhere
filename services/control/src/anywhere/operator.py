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
from pydantic import BaseModel, Field, model_validator

from .desktop import Frame, Screen, prepare_frame
from .llm import ainvoke_json

log = structlog.get_logger()

MAX_STEPS = 40

SYSTEM = """You are Anywhere's desktop operator. You control a real Linux (XFCE) desktop \
by looking at screenshots and choosing ONE action at a time.

Environment:
- Blender is installed (`blender`). Projects live in ~/Projects, which is saved \
persistently; save work there.
- A shell runs inside this desktop. Use it for file operations and to launch apps, e.g. \
`nohup blender >/tmp/blender.log 2>&1 &`. Prefer the GUI for anything the user should see happen.

How to work:
- Look carefully at the latest screenshot before acting. Coordinates are pixels in that \
screenshot (origin top-left, size {width}x{height}).
- Prefer reliable keyboard shortcuts when an application supports them.
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


StepSink = Callable[[str, str, str, bytes | None], Awaitable[None]]
ControlCheck = Callable[[], Awaitable[bool]]


def build_operator(*, llm, screen: Screen, record: StepSink, has_control: ControlCheck, max_steps: int = MAX_STEPS):
    """Compile the operator graph for one desktop session."""

    async def observe(state: OpState) -> OpState:
        if not await has_control():
            return {"status": "paused", "result": "You took control. I'll pick up when you hand it back."}
        png = await screen.screenshot()
        frame = prepare_frame(png)
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
        action = Action.model_validate(state["action"])
        meta = state["frame_meta"]
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

        if not await has_control():
            return {"status": "paused", "result": "You took control. I'll pick up when you hand it back."}

        outcome = "ok"
        try:
            outcome = await _execute(screen, action, frame)
        except Exception as exc:  # surfaced to the model so it can recover
            outcome = f"error: {exc}"
            log.warning("operator.action_failed", action=action.action, error=str(exc))

        await record(
            "act", label, json.dumps({"thought": action.thought, **_public(action), "outcome": outcome[:500]}), None
        )
        history = [*state.get("history", []), f"{label} → {outcome[:160]}"]
        status = "running" if step < max_steps else "failed"
        result = "" if status == "running" else f"Stopped after {max_steps} steps without finishing."
        return {"history": history, "outcome": outcome, "step": step, "status": status, "result": result}

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
            await screen.scroll(*xy(a.x, a.y), a.dy or 3)
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
