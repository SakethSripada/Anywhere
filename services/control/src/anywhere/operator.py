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
import base64
import json
import re
import uuid
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
#: A blender_python script longer than this is refused (the model's reply budget is ~8k tokens).
MAX_CODE = 24_000
#: Where Blender's startup script (environments/blender-autosave.py) picks up scripts to run.
RUN_DIR = "/tmp/anywhere-run"
#: How long to wait for Blender to run a script and write its result.
RUN_WAIT_SECONDS = 90

#: What the operator says when the user takes the controls mid-task.
PAUSED = "You took control. I'll pick up when you hand it back."

SYSTEM = """You are Anywhere's desktop operator. You control a real Linux (XFCE) desktop \
by looking at screenshots and choosing ONE action at a time.

Environment:
- Blender is installed (`blender`). Projects live in ~/Projects, which is saved \
persistently; save work there.
- A shell runs inside this desktop. Use it for file operations and to launch apps. If Blender \
isn't open, start it with `cd ~/Projects && DISPLAY=:1 nohup blender $([ -f scene.blend ] && echo \
scene.blend) --python /tmp/anywhere_autosave.py >/tmp/blender.log 2>&1 &` (that script is what \
lets blender_python run and keeps the scene saved).

Building in Blender with Python (blender_python):
- For anything beyond a few objects (a scene, a procedural or repeated structure, materials, \
lighting, modifiers, geometry nodes, animation), write bpy code and send it as ONE \
"blender_python" action with the code in "code". It runs inside the open Blender window, so the \
result appears live on screen. You get back "ok" plus anything it printed, or the traceback: \
fix the code and send it again.
- Build in steps the user can watch (e.g. terrain, then buildings, then materials and lights, \
then camera and animation), each one a separate blender_python action, rather than one giant script.
- Scripts already have bpy, bmesh, math, random, mathutils and `kit` (no import needed), tested helpers for the \
plumbing (use them; spend your code on the design): kit.clear() empties the scene; \
kit.material(name, color, metallic=0, roughness=0.5, emission=None, strength=0); \
kit.windows(name, glow=(r, g, b), strength=8, scale=2, lit=0.4, seed=0) is a facade with \
randomly lit windows for buildings; kit.box(name, (x, y, z), (sx, sy, sz), material) is a box \
standing on (x, y, z); kit.sphere(name, (x, y, z), radius, material); kit.world(color, strength) sets the background; kit.sun(name, rotation, \
color, energy); kit.orbit_camera(target, radius, height, frames) adds an aimed camera circling \
the target and makes it the scene camera; kit.glow() adds bloom; kit.show() looks through the \
camera with rendered shading; kit.play() plays the animation; kit.save() saves.
- Blender 4.5 API notes: prefer bpy.data and bmesh over bpy.ops. Principled BSDF inputs are \
"Base Color", "Metallic", "Roughness", "Emission Color", "Emission Strength", "Alpha". The \
EEVEE engine id is "BLENDER_EEVEE_NEXT". Don't set EEVEE or shadow tuning properties \
(use_bloom, use_ssr, shadow_map_size and the like are gone); the defaults are fine. Link new \
objects with bpy.context.scene.collection.objects.link(obj). Keyframe with \
obj.keyframe_insert("location", frame=N).
- Keep it under ~1000 objects: put repeated detail (windows, tiles) in a material or one bmesh \
mesh, never thousands of separate objects.
- Make it look striking, never a gray box: every object gets a material, glowing things get \
emission strength 5-30, night scenes get a near-black world and kit.glow(). Finish with \
kit.show() and kit.save(), then check the screenshot shows the lit result before saying done.

Blender (keyboard first; its menu rows are small and easy to miss with a click):
- Blender shortcuts act on the panel under the mouse: "move" over the 3D viewport first.
- Add or run anything with search: press F3, type the name (e.g. "Cylinder", "Subdivision \
Surface"), then press Enter. Shift+A opens the Add menu if you need to browse.
- Move, rotate or scale the selection with a "key" action, mouse over the viewport: \
keys ["g", "x", "3", "Return"] moves 3 m along X (r rotates, s scales, y/z pick the axis). \
Never "type" these with spaces: in Blender a space plays the animation and a bare x opens \
Delete. If a Delete prompt appears, press Escape. Tab toggles Edit Mode. Ctrl+S saves.
- Check a transform worked in the Location/Rotation/Scale fields on the right (Object \
properties or the N panel) before saying it's done.
- New objects appear at the 3D cursor (usually the origin) and can hide inside others: move \
them, then check the Outliner (top right) lists what you added before saying you're done.

How to work:
- Look carefully at the latest screenshot before acting. Give coordinates on a 0-1000 grid \
over that screenshot: (0, 0) is the top-left corner and (1000, 1000) the bottom-right, \
whatever its pixel size ({width}x{height}).
- Prefer reliable keyboard shortcuts when an application supports them.
- To scroll, give the point to scroll at and "dy" in wheel notches: positive scrolls down, \
negative scrolls up, at most 10 at a time.
- After an action, verify its effect on the next screenshot before moving on. If something \
didn't work, try a different approach instead of repeating it.
- Only claim what you can see: name the objects or changes visible on the last screenshot. \
When the goal is achieved and visibly verified, return action "done" with a short summary \
of what you did. If it is impossible, return "fail" with the reason.

Reply with ONLY a JSON object:
{{"thought": "<one sentence on what you see and why this action>",
  "summary": "<a few words for the user, e.g. 'Opening the Add menu'>",
  "action": "click|double_click|right_click|move|drag|type|key|scroll|shell|blender_python|wait|done|fail",
  "x": int, "y": int, "x2": int, "y2": int,
  "text": "<text to type, or result for done/fail>",
  "keys": ["ctrl","s"], "dy": int, "command": "<shell command>", "code": "<bpy Python>"}}
Include only the fields the action needs."""

ActionName = Literal[
    "click",
    "double_click",
    "right_click",
    "move",
    "drag",
    "type",
    "key",
    "scroll",
    "shell",
    "blender_python",
    "wait",
    "done",
    "fail",
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
    "python": "blender_python",
    "bpy": "blender_python",
    "run_python": "blender_python",
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
    code: str | None = None

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
        if self.action == "blender_python":
            if not self.code:
                raise ValueError("blender_python requires code")
            if len(self.code) > MAX_CODE:
                raise ValueError(f"code is too long; split it into steps under {MAX_CODE} characters")
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
        png = await _screenshot(screen)
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


async def _screenshot(screen: Screen, attempts: int = 3, delay: float = 2.0) -> bytes:
    """Screenshots are safe to repeat, and one slow read over the SSH tunnel
    ("Timeout on reading data from socket", seen live) shouldn't end the run."""
    for attempt in range(attempts):
        try:
            return await screen.screenshot()
        except asyncio.CancelledError:
            raise
        except Exception:
            if attempt == attempts - 1:
                raise
            await asyncio.sleep(delay * (attempt + 1))
    raise AssertionError("unreachable")


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


MODIFIERS = {"ctrl", "control", "shift", "alt", "super", "meta", "cmd", "win"}


def key_chords(keys: list[str]) -> list[list[str]]:
    """Split a keys list into presses: modifiers hold for the next key, everything else is
    pressed in turn. ["ctrl", "s"] is one chord; ["g", "x", "3", "enter"] is four presses
    (sent as one chord on a live run, it did nothing while the agent reported a move)."""
    chords: list[list[str]] = []
    held: list[str] = []
    for k in keys:
        if k in MODIFIERS:
            held.append(k)
        else:
            chords.append([*held, k])
            held = []
    if held:
        chords.append(held)
    return chords


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
            # Models often add the confirming key to a type action ("3" then Return); seen
            # live, typing alone left a Blender field in edit mode.
            for chord in key_chords([k.lower() for k in a.keys or []]):
                await screen.keys(chord)
        case "key":
            for chord in key_chords([k.lower() for k in a.keys or []]):
                await screen.keys(chord)
        case "shell":
            command = a.command or ""
            if not command_allowed(command):
                return "refused: that command could destroy data; choose a safer approach"
            code, out = await screen.shell(command, timeout=60)
            return f"exit {code}: {out.strip()[-400:]}" if out.strip() else f"exit {code}"
        case "blender_python":
            outcome = await run_in_blender(screen, a.code or "")
            await asyncio.sleep(0.6)
            return outcome
        case "wait":
            await asyncio.sleep(2)
    # Give the UI a moment to settle before the next screenshot.
    await asyncio.sleep(0.6)
    return "ok"


async def run_in_blender(screen: Screen, code: str) -> str:
    """Hand a script to the open Blender (see environments/blender-autosave.py) and wait
    for its result. Written under a temporary name and renamed, so Blender never reads half."""
    name = f"op-{uuid.uuid4().hex[:12]}"
    script, out = f"{RUN_DIR}/{name}.py", f"{RUN_DIR}/{name}.out"
    payload = base64.b64encode(code.encode()).decode()
    polls = RUN_WAIT_SECONDS * 2
    command = (
        f"mkdir -p {RUN_DIR} && echo {payload} | base64 -d > {script}.part && mv {script}.part {script} && "
        f"for i in $(seq 1 {polls}); do if [ -f {out} ]; then cat {out}; rm -f {out}; exit 0; fi; sleep 0.5; done; "
        f"if [ -f {script} ]; then rm -f {script}; echo NOT_PICKED_UP; else echo STILL_RUNNING; fi"
    )
    _, text = await screen.shell(command, timeout=RUN_WAIT_SECONDS + 20)
    text = text.strip()
    if text.endswith("NOT_PICKED_UP"):
        return (
            "error: Blender didn't pick up the script. It isn't open, or it was started without "
            "/tmp/anywhere_autosave.py. Start it the way the instructions say, then send the code again."
        )
    if text.endswith("STILL_RUNNING"):
        return f"still running after {RUN_WAIT_SECONDS}s; wait, then check the screen before sending more"
    status, _, rest = text.partition("\n")
    if status == "ok":
        return "ok" + (f", printed: {rest.strip()[-800:]}" if rest.strip() else "")
    return f"error in your code:\n{rest.strip()[-1500:]}"
