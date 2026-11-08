"""The Anywhere agent: one Nemotron-powered LangGraph agent with specialised tools.

Nemotron reasons about what the user wants and fills typed tool arguments.
It never picks hardware or prices — `propose_workload` hands its intent to the
deterministic planner and budget policy, and only that path can create work.
Conversation state is checkpointed per thread (one per conversation), so a
chat survives restarts and continues seamlessly across web and iMessage.
"""

from __future__ import annotations

import asyncio
import json
import time
from contextlib import AsyncExitStack
from dataclasses import dataclass, field

import structlog
from langchain_core.messages import AIMessage, HumanMessage, RemoveMessage, SystemMessage, ToolMessage
from langchain_core.tools import StructuredTool
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.errors import GraphRecursionError
from langgraph.graph import START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition
from pydantic import BaseModel, Field

from . import budget, llm
from .core import ActionError, Anywhere
from .ids import new_id
from .lifecycle import BILLABLE, Status
from .planner import Intent

log = structlog.get_logger()

SYSTEM = """You are Anywhere, an assistant that provisions and operates powerful computers for people.
Users describe outcomes; you figure out the compute, set it up, and do the work.

What you can do today:
- Interactive GPU desktops in the browser (Blender, VS Code, JupyterLab, or a plain Linux desktop).
- Fine-tune language models (LoRA/QLoRA) on an uploaded .jsonl or .csv dataset.
- Render Blender scenes on a fast GPU (kind "render"): the scene is copied from a desktop's ~/Projects
  (live if it's running, else its last saved copy), rendered, and the frames come back; the render
  machine shuts down when done and the user gets a message with the first frame attached.
- Measure render time on a running desktop with estimate_render (a quick test render, ~1 minute).
- Split a long animation across several GPUs at once (render_machines, up to 8): about that many
  times faster for about the same total cost. Offer it when an animation would take a while.
- Build and render 3D scenes in a running Blender desktop in seconds (build_scene).
- Operate a running desktop yourself: clicking, typing, using apps like Blender (operate_desktop).
- Check on, save, stop, resume and delete the user's machines.

Rules:
- NEVER state hardware, prices or runtimes you didn't get from a tool. To plan anything, call
  propose_workload with what you understood; it returns the validated plan and cost.
- After proposing, summarise the plan in plain language (what, which GPU, estimated cost, confidence)
  and ask the user to approve it. Only call approve_workload when the user has clearly said yes to
  that specific plan in their latest message.
- If a tool says something isn't supported or is blocked, say so honestly and offer the closest option.
- Avoid infrastructure jargon unless the user asks. Be brief and warm.
- Never use em dashes. Use commas, periods or parentheses instead. No marketing language.
- Anything to make, build, model, render or show in Blender ("render a dragon", "make a neon city",
  "show me a rocket launch") goes to build_scene with their words as the request, on their running
  desktop. It's fast (under a minute) and sends a rendered picture back by itself, so just say it's
  being built live and the picture is coming. Never start a new machine for this if one is running.
- When the user asks for something else to be done inside a running desktop, use operate_desktop with a
  precise, self-contained goal. Don't narrate each click; the user can watch.
- While the desktop agent is working, a message that changes or adds to the task means calling
  operate_desktop again with the complete updated goal (it replaces the current task). "Stop" or
  "cancel" about the task means stop_desktop_agent, never stop_workload, which turns the machine off.
- Ask a clarifying question only when you truly can't proceed.
- Desktop time is not render time. A desktop plan prices time at the machine; users are billed only
  while it runs and can stop any time. Only set session_hours (with session_hours_stated=true) when
  the user said how long they need. Never invent a long session to cover a big project.
- For "how long will it render": quote the plan's render_time table as a range, and for a scene saved
  on a running desktop call estimate_render for a measured number. Heavy scenes with fog or many lights
  are "heavy"; dense props and textures are "detailed".
- To answer questions about a machine or job (progress, errors, outputs), call inspect_workload first.
{channel_rules}{focus}
Current state:
{state}"""

IMESSAGE_RULES = """- This conversation is over iMessage: plain text only, no markdown, at most ~3 short sentences.
- For approvals over iMessage, the user replying "yes" or "approve" counts as approval of the latest plan.
- "Render my alley scene": propose kind "render" with scene="alley". Leave render_from_workload_id out
  unless they named a desktop; the desktop holding their files is found for you. Say you'll text them
  when it's done, with the first frame.
- "Show me" / "send a pic" / "what does it look like": call send_screenshot. The picture arrives right
  after your reply, so keep the reply short ("Here's the desktop right now.").
- A desktop task started from here is texted back automatically when it finishes, with a picture of
  the result. So after operate_desktop, just say it's underway and you'll text when it's done.
- "Keep me posted" / "update me every N minutes": call set_progress_updates (default 5 minutes if no
  number was given). "Stop the updates" means every_minutes=0.
- "How's it going?" / progress questions: call inspect_workload and answer from current_steps.
- "Let me watch" / "send a link" / "open it on my phone": call share_watch_link and text the url. When a
  desktop you started becomes ready, offer that link."""


class ProposeArgs(Intent):
    dataset_upload_id: int | None = Field(None, description="Upload id of an attached dataset, if any.")
    render_from_workload_id: int | None = Field(
        None,
        description="Render jobs: the desktop whose ~/Projects holds the scene (running, or stopped with saved files).",
    )
    blend_path: str | None = Field(None, description="Render jobs: the .blend inside ~/Projects; default newest.")
    scene: str | None = Field(
        None, description='Render jobs: the scene\'s name as the user said it ("alley"), when no exact path is known.'
    )


class EstimateRenderArgs(BaseModel):
    workload_id: int
    blend_path: str | None = Field(None, description="A .blend inside ~/Projects; default the newest one.")
    samples: int | None = Field(None, description="Override the scene's sample count, if the user asked.")
    frames: int = Field(1, description="How many frames the user plans to render.")


class WorkloadArg(BaseModel):
    workload_id: int


class SceneArgs(BaseModel):
    request: str = Field(description="What to build, in the user's words, e.g. 'a dragon over a lava lake'.")
    workload_id: int | None = Field(None, description="The desktop to build on; defaults to the running one.")


class ScreenshotArgs(BaseModel):
    workload_id: int


class UpdatesArgs(BaseModel):
    workload_id: int
    every_minutes: int = Field(5, description="Minutes between progress texts (1-60); 0 turns updates off.")


class OperateArgs(BaseModel):
    workload_id: int
    goal: str = Field(description="A precise, self-contained instruction for what to do on the desktop.")


@dataclass
class TurnContext:
    owner: str
    conversation_id: int
    channel: str  # "web" | "imessage"
    #: Set when the user is chatting from a desktop or job page.
    focus_workload_id: int | None = None
    #: Pictures (JPEG bytes) to send after the reply, e.g. a screenshot the user asked for over iMessage.
    attachments: list[bytes] = field(default_factory=list)


FOCUS = """
The user is chatting from the page of workload #{id} ("{title}", a {kind}, currently {status}).
"this", "it", "the desktop" or "the job" mean that workload. Use its id for tools without asking."""


def trim_history(messages: list, limit: int = 30) -> list:
    """The last `limit` messages, never starting on a tool result: a ToolMessage
    without the assistant message that requested it is rejected by the API."""
    history = list(messages[-limit:])
    while history and isinstance(history[0], ToolMessage):
        history.pop(0)
    return history


#: Messages kept in a conversation's checkpointed state. The model only ever sees
#: the last 30 (trim_history); anything older is dead weight that every graph
#: step re-serialises into the checkpoint, so it is removed from the state.
HISTORY_KEEP = 60


def prune_history(messages: list, keep: int = HISTORY_KEEP) -> list:
    """RemoveMessage markers for everything before the last `keep` messages, never
    leaving the kept history starting on an orphaned tool result."""
    if len(messages) <= keep:
        return []
    cut = len(messages) - keep
    while cut < len(messages) and isinstance(messages[cut], ToolMessage):
        cut += 1
    return [RemoveMessage(id=m.id) for m in messages[:cut] if getattr(m, "id", None)]


def _failed(output: str) -> bool:
    try:
        data = json.loads(output)
        return isinstance(data, dict) and data.get("ok") is False
    except (TypeError, ValueError):
        return output.startswith(("Could not", "Tool failed"))


def _recorded(app: Anywhere, ctx: TurnContext, tool: StructuredTool) -> StructuredTool:
    """Mirror each tool call into the conversation so every client can render it live.

    A `tool_call` message is posted when the call starts and a `tool_result`
    with the same call id when it ends. Recording never breaks the turn.
    """
    inner = tool.coroutine

    async def post(kind: str, body: dict, workload_id: int) -> None:
        try:
            await app.store.append_message(
                ctx.conversation_id, "assistant", kind, json.dumps(body, default=str), workload_id, ctx.channel
            )
        except Exception as exc:
            log.warning("agent.tool_record_failed", tool=tool.name, error=str(exc))

    async def run(**kwargs) -> str:
        call_id = new_id()
        workload_id = int(kwargs.get("workload_id") or ctx.focus_workload_id or 0)
        await post("tool_call", {"call_id": call_id, "name": tool.name, "args": kwargs}, workload_id)
        started = time.monotonic()
        try:
            output = await inner(**kwargs)
        except Exception as exc:
            output = f"Tool failed: {exc.__class__.__name__}: {exc}"
        try:
            parsed = json.loads(output)
            if isinstance(parsed, dict) and parsed.get("workload_id"):
                workload_id = int(parsed["workload_id"])
        except (TypeError, ValueError):
            pass
        await post(
            "tool_result",
            {
                "call_id": call_id,
                "name": tool.name,
                "ok": not _failed(output),
                "output": output[:6000],
                "ms": round((time.monotonic() - started) * 1000),
            },
            workload_id,
        )
        return output

    return StructuredTool.from_function(
        coroutine=run, name=tool.name, description=tool.description, args_schema=tool.args_schema
    )


def _tools(app: Anywhere, ctx: TurnContext) -> list[StructuredTool]:
    #: Desktops the agent was started on in this turn. Starting replaces the running task,
    #: so a model that calls operate_desktop again in the same turn (seen live, in a loop
    #: until the recursion limit) would restart the run each time.
    operated: dict[int, str] = {}

    async def propose_workload(**kwargs) -> str:
        upload = kwargs.pop("dataset_upload_id", None)
        source = kwargs.pop("render_from_workload_id", None)
        blend = kwargs.pop("blend_path", None)
        scene = kwargs.pop("scene", None)
        try:
            intent = Intent.model_validate(kwargs)
            return json.dumps(
                await app.propose(
                    ctx.owner, ctx.conversation_id, intent, upload, render_from=source, blend_path=blend, scene=scene
                )
            )
        except (ActionError, ValueError) as exc:
            return json.dumps({"ok": False, "message": str(exc)})

    async def approve_workload(workload_id: int) -> str:
        try:
            await app.approve(ctx.owner, workload_id)
            return "Approved. Provisioning has started; progress updates will follow automatically."
        except ActionError as exc:
            return f"Could not approve: {exc}"

    async def list_workloads() -> str:
        rows = await app.store.workloads_for(ctx.owner)
        rows.sort(key=lambda w: w["createdAt"], reverse=True)
        return json.dumps(
            [
                {
                    "workload_id": w["id"],
                    "title": w["title"],
                    "kind": w["kind"],
                    "status": w["status"],
                    "detail": w["statusDetail"],
                    "gpu": w["gpuName"],
                    "spent": budget.usd(int(w["accruedCents"])),
                    "estimate_high": budget.usd(int(w["estHighCents"])),
                }
                for w in rows[:12]
            ]
        )

    def lifecycle(fn, done: str):
        async def run(workload_id: int) -> str:
            try:
                await fn(ctx.owner, workload_id)
                return done
            except ActionError as exc:
                return f"Could not do that: {exc}"

        return run

    async def estimate_render(
        workload_id: int, blend_path: str | None = None, samples: int | None = None, frames: int = 1
    ) -> str:
        try:
            return json.dumps(await app.estimate_render(ctx.owner, workload_id, blend_path, samples, frames))
        except ActionError as exc:
            return json.dumps({"ok": False, "message": str(exc)})

    async def operate_desktop(workload_id: int, goal: str) -> str:
        if workload_id in operated:
            return json.dumps(
                {
                    "ok": True,
                    "run_id": operated[workload_id],
                    "message": "Already started in this turn and working now. Don't call this again; "
                    "tell the user it's underway.",
                }
            )
        try:
            # A new goal while it works is the user steering: it replaces the current task.
            run_id = await app.operate(ctx.owner, workload_id, goal, replace=True, channel=ctx.channel)
            operated[workload_id] = str(run_id)
            return json.dumps(
                {
                    "ok": True,
                    "run_id": run_id,
                    "workload_id": workload_id,
                    "message": "The desktop agent started. It reports back when finished; the user can watch live.",
                }
            )
        except (ActionError, RuntimeError) as exc:
            return json.dumps({"ok": False, "message": f"Could not start the desktop agent: {exc}"})

    async def stop_desktop_agent(workload_id: int) -> str:
        try:
            await app.halt_agent(ctx.owner, workload_id)
            return json.dumps(
                {
                    "ok": True,
                    "workload_id": workload_id,
                    "message": "Stopped the desktop agent. The machine is still on.",
                }
            )
        except ActionError as exc:
            return json.dumps({"ok": False, "message": f"Could not stop the desktop agent: {exc}"})

    async def send_screenshot(workload_id: int) -> str:
        try:
            w = await app.owned(ctx.owner, workload_id)
        except ActionError as exc:
            return json.dumps({"ok": False, "message": str(exc)})
        if w["kind"] != "desktop" or w["status"] != Status.RUNNING:
            return json.dumps(
                {"ok": False, "message": f"{w['title']} isn't a running desktop, so there's nothing to show."}
            )
        try:
            frame = await app.supervisor.shots.frame(
                int(w["id"]), app.supervisor.remote(w), app.vault.agent_token(int(w["id"]))
            )
        except Exception as exc:
            log.warning("agent.screenshot_failed", workload=workload_id, error=str(exc)[:300])
            return json.dumps(
                {"ok": False, "message": "Couldn't reach the desktop for a screenshot. Try again shortly."}
            )
        if len(ctx.attachments) < 3:
            ctx.attachments.append(frame.jpeg)
        return json.dumps(
            {"ok": True, "workload_id": workload_id, "message": "Screenshot taken; it is sent right after your reply."}
        )

    async def set_progress_updates(workload_id: int, every_minutes: int = 5) -> str:
        try:
            await app.owned(ctx.owner, workload_id)
        except ActionError as exc:
            return json.dumps({"ok": False, "message": str(exc)})
        minutes = app.set_progress_updates(workload_id, every_minutes)
        if not minutes:
            return json.dumps({"ok": True, "workload_id": workload_id, "message": "Progress updates are off."})
        return json.dumps(
            {
                "ok": True,
                "workload_id": workload_id,
                "message": f"Texting a progress update with a screenshot every {minutes} min while the desktop "
                "agent works, plus a message with a picture when it finishes.",
            }
        )

    async def inspect_workload(workload_id: int) -> str:
        try:
            w = await app.owned(ctx.owner, workload_id)
        except ActionError as exc:
            return json.dumps({"ok": False, "message": str(exc)})
        t = await app.store.telemetry(workload_id)
        logs = "".join(c["text"] for c in sorted(t["logs"], key=lambda c: c["id"]))[-2500:]
        latest: dict[str, dict] = {}
        for p in sorted(t["metrics"], key=lambda p: p["step"]):
            latest[p["name"]] = {"step": p["step"], "value": round(float(p["value"]), 5)}
        runs = sorted(t["agent_runs"], key=lambda r: r["startedAt"], reverse=True)[:2]
        current_steps: list[str] = []
        if runs and runs[0]["status"] == "running":
            try:
                steps = await app.store.agent_step_summaries(int(runs[0]["id"]))
                current_steps = [s["summary"] for s in steps if s["kind"] != "observe"][-8:]
            except Exception as exc:
                log.warning("agent.steps_failed", workload=workload_id, error=str(exc)[:200])
        return json.dumps(
            {
                "ok": True,
                "workload_id": w["id"],
                "title": w["title"],
                "kind": w["kind"],
                "status": w["status"],
                "detail": w["statusDetail"],
                "gpu": w["gpuName"],
                "spent": budget.usd(int(w["accruedCents"])),
                "estimate": f"{budget.usd(int(w['estLowCents']))}-{budget.usd(int(w['estHighCents']))}",
                "controller": w["controller"],
                "recent_events": [e["message"] for e in sorted(t["events"], key=lambda e: e["id"])[-8:]],
                "latest_metrics": latest,
                "log_tail": logs,
                "outputs": [a["name"] for a in t["artifacts"]],
                "agent_runs": [{"goal": r["goal"], "status": r["status"], "result": r["result"]} for r in runs],
                "agent_working_now": app.supervisor.agent_running(int(w["id"])),
                "current_steps": current_steps,
                "progress_updates_every_min": int(app.vault.get(int(w["id"])).get("update_every_min") or 0),
            },
            default=str,
        )

    async def build_scene(request: str, workload_id: int | None = None) -> str:
        from .lifecycle import Status
        from .scene import build

        mine = [x for x in await app.store.workloads_for(ctx.owner) if x["kind"] == "desktop"]
        if workload_id is None:
            running = [x for x in mine if x["status"] == Status.RUNNING]
            if not running:
                return json.dumps({"ok": False, "message": "No desktop is running. Offer to start a Blender desktop."})
            w = running[0]
        else:
            try:
                w = await app.owned(ctx.owner, workload_id)
            except ActionError as exc:
                return json.dumps({"ok": False, "message": str(exc)})
        if w["status"] != Status.RUNNING:
            return json.dumps({"ok": False, "message": f"{w['title']} isn't running."})
        tasks = app.__dict__.setdefault("_scene_tasks", {})
        busy = tasks.get(int(w["id"]))
        if busy is not None and not busy.done():
            return json.dumps({"ok": False, "message": "It's still building the last request. Give it a moment."})
        tasks[int(w["id"])] = asyncio.create_task(build(app, w, request))
        return json.dumps(
            {
                "ok": True,
                "workload_id": int(w["id"]),
                "message": "Building it live in Blender now (watch the desktop); a rendered picture arrives "
                "in under a minute. Tell the user that in one short sentence.",
            }
        )

    async def share_watch_link(workload_id: int) -> str:
        try:
            made = await app.create_share(ctx.owner, workload_id, 4)
        except ActionError as exc:
            return json.dumps({"ok": False, "message": str(exc)})
        url = f"{app.settings.public_web_origin}/watch/{made['token']}"
        return json.dumps(
            {
                "ok": True,
                "url": url,
                "message": "View-only live link, works on any phone or laptop for 4 hours. Give the user the url.",
            }
        )

    tools = [
        StructuredTool.from_function(
            coroutine=build_scene,
            name="build_scene",
            description="Build and render a 3D scene in the running Blender desktop from a description, live and "
            "fast, then send back a rendered picture. Use for any make/build/render/model/show request.",
            args_schema=SceneArgs,
        ),
        StructuredTool.from_function(
            coroutine=share_watch_link,
            name="share_watch_link",
            description="Make a view-only link to watch a running desktop live on any device (phone, laptop, "
            "projector), no sign-in. Use when the user wants to watch, show someone, or open it on their phone.",
            args_schema=WorkloadArg,
        ),
        StructuredTool.from_function(
            coroutine=propose_workload,
            name="propose_workload",
            description="Turn the user's request into a validated compute plan with cost. Required before any work.",
            args_schema=ProposeArgs,
        ),
        StructuredTool.from_function(
            coroutine=approve_workload,
            name="approve_workload",
            description="Start a planned workload. Only after the user explicitly approves that plan.",
            args_schema=WorkloadArg,
        ),
        StructuredTool.from_function(
            coroutine=list_workloads,
            name="list_workloads",
            description="List the user's machines and jobs with status and spend.",
        ),
        StructuredTool.from_function(
            coroutine=lifecycle(app.stop, "Stopping. Files are saved first; resume any time."),
            name="stop_workload",
            description="Save and stop a running desktop, or stop a job.",
            args_schema=WorkloadArg,
        ),
        StructuredTool.from_function(
            coroutine=lifecycle(app.resume, "Resuming the desktop. It takes a few minutes to come back."),
            name="resume_desktop",
            description="Restart a stopped desktop with its saved files.",
            args_schema=WorkloadArg,
        ),
        StructuredTool.from_function(
            coroutine=lifecycle(app.save, "Saving project files now."),
            name="save_project",
            description="Snapshot a running desktop's project files to durable storage.",
            args_schema=WorkloadArg,
        ),
        StructuredTool.from_function(
            coroutine=lifecycle(app.terminate, "Deleting the machine (saving files first if it's running)."),
            name="delete_workload",
            description="Permanently delete a machine. Confirm with the user first.",
            args_schema=WorkloadArg,
        ),
        StructuredTool.from_function(
            coroutine=estimate_render,
            name="estimate_render",
            description="Measure how long a saved Blender scene renders on a running desktop's GPU (quick test render).",
            args_schema=EstimateRenderArgs,
        ),
        StructuredTool.from_function(
            coroutine=operate_desktop,
            name="operate_desktop",
            description=(
                "Have the desktop agent perform a task in a running desktop (GUI and terminal). "
                "If it is already working, this replaces its current task with the new goal."
            ),
            args_schema=OperateArgs,
        ),
        StructuredTool.from_function(
            coroutine=stop_desktop_agent,
            name="stop_desktop_agent",
            description=(
                "Stop the desktop agent's current task and give the user the controls. "
                "The machine keeps running; use stop_workload only to turn the machine off."
            ),
            args_schema=WorkloadArg,
        ),
        StructuredTool.from_function(
            coroutine=inspect_workload,
            name="inspect_workload",
            description=(
                "Status, recent events, latest training metrics, log tail, outputs and agent runs for one workload. "
                "current_steps lists what the desktop agent has done so far in its running task."
            ),
            args_schema=WorkloadArg,
        ),
        StructuredTool.from_function(
            coroutine=set_progress_updates,
            name="set_progress_updates",
            description=(
                "Text the user a progress update with a screenshot every N minutes while the desktop agent works "
                "on this machine. every_minutes=0 turns them off."
            ),
            args_schema=UpdatesArgs,
        ),
    ]
    if ctx.channel == "imessage":
        tools.append(
            StructuredTool.from_function(
                coroutine=send_screenshot,
                name="send_screenshot",
                description="Text the user a live screenshot of a running desktop (sent right after your reply).",
                args_schema=ScreenshotArgs,
            )
        )
    return [_recorded(app, ctx, t) for t in tools]


class Agent:
    """Owns the checkpointer and runs one turn at a time per conversation."""

    def __init__(self, app: Anywhere):
        self.app = app
        self._stack = AsyncExitStack()
        self.checkpointer: AsyncSqliteSaver | None = None

    async def start(self) -> None:
        path = self.app.settings.data_dir / "agent.sqlite"
        path.parent.mkdir(parents=True, exist_ok=True)
        self.checkpointer = await self._stack.enter_async_context(AsyncSqliteSaver.from_conn_string(str(path)))

    async def close(self) -> None:
        await self._stack.aclose()

    async def _state_summary(self, owner: str) -> str:
        active = await self.app.store.workloads_for(owner)
        live = [
            f"- #{w['id']} {w['title']} ({w['kind']}): {w['status']}{self._agent_note(w)}"
            for w in active
            if w["status"] in BILLABLE | {"stopped", "planned"}
        ]
        return "\n".join(live) or "- No active machines."

    def _agent_note(self, w: dict) -> str:
        if not self.app.supervisor.agent_running(int(w["id"])):
            return ""
        goal = str(self.app.vault.get(int(w["id"])).get("last_goal") or "")[:200]
        return f'; the desktop agent is working on "{goal}"'

    async def respond(self, ctx: TurnContext, text: str) -> str:
        if self.checkpointer is None:
            raise RuntimeError("Agent not started")
        model = llm.planner(self.app.settings)
        tools = _tools(self.app, ctx)
        bound = model.bind_tools(tools)
        focus = ""
        if ctx.focus_workload_id:
            w = await self.app.store.workload(ctx.focus_workload_id)
            if w and w["owner"] == ctx.owner:
                focus = FOCUS.format(id=w["id"], title=w["title"], kind=w["kind"], status=w["status"])
        system = SystemMessage(
            SYSTEM.format(
                channel_rules=IMESSAGE_RULES if ctx.channel == "imessage" else "",
                focus=focus,
                state=await self._state_summary(ctx.owner),
            )
        )

        async def call_model(state: MessagesState) -> dict:
            try:
                reply = await bound.ainvoke([system, *trim_history(state["messages"])])
            except Exception as exc:
                self.app.readiness.record_call("nemotron", "Nemotron planner model", exc)
                raise
            self.app.readiness.record_call("nemotron", "Nemotron planner model", None)
            return {"messages": [*prune_history(state["messages"]), reply]}

        g = StateGraph(MessagesState)
        g.add_node("agent", call_model)
        g.add_node("tools", ToolNode(tools))
        g.add_edge(START, "agent")
        g.add_conditional_edges("agent", tools_condition)
        g.add_edge("tools", "agent")
        graph = g.compile(checkpointer=self.checkpointer)

        config = {"configurable": {"thread_id": f"conversation-{ctx.conversation_id}"}, "recursion_limit": 24}
        try:
            result = await graph.ainvoke({"messages": [HumanMessage(text)]}, config)
        except GraphRecursionError:
            log.warning("agent.recursion_limit", conversation=ctx.conversation_id)
            return "I went around in circles on that one. Tell me what you'd like next, or ask again more specifically."
        reply = next((m for m in reversed(result["messages"]) if isinstance(m, AIMessage) and m.content), None)
        content = reply.content if reply else ""
        if isinstance(content, list):
            content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
        return str(content).strip() or "Done."
