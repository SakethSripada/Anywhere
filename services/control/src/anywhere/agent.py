"""The Anywhere agent: one Nemotron-powered LangGraph agent with specialised tools.

Nemotron reasons about what the user wants and fills typed tool arguments.
It never picks hardware or prices — `propose_workload` hands its intent to the
deterministic planner and budget policy, and only that path can create work.
Conversation state is checkpointed per thread (one per conversation), so a
chat survives restarts and continues seamlessly across web and iMessage.
"""

from __future__ import annotations

import json
import time
from contextlib import AsyncExitStack
from dataclasses import dataclass

import structlog
from langchain_core.messages import AIMessage, HumanMessage, RemoveMessage, SystemMessage, ToolMessage
from langchain_core.tools import StructuredTool
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.graph import START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition
from pydantic import BaseModel, Field

from . import budget, llm
from .core import ActionError, Anywhere
from .ids import new_id
from .lifecycle import BILLABLE
from .planner import Intent

log = structlog.get_logger()

SYSTEM = """You are Anywhere, an assistant that provisions and operates powerful computers for people.
Users describe outcomes; you figure out the compute, set it up, and do the work.

What you can do today:
- Interactive GPU desktops in the browser (Blender, VS Code, JupyterLab, or a plain Linux desktop).
- Fine-tune language models (LoRA/QLoRA) on an uploaded .jsonl or .csv dataset.
- Render Blender scenes on a fast GPU (kind "render"): the scene is copied from a running desktop's
  ~/Projects, rendered, and the frames come back; the render machine shuts down when done.
- Measure render time on a running desktop with estimate_render (a quick test render, ~1 minute).
- Split a long animation across several GPUs at once (render_machines, up to 8): about that many
  times faster for about the same total cost. Offer it when an animation would take a while.
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
- When the user asks for something to be done inside a running desktop, use operate_desktop with a
  precise, self-contained goal. Don't narrate each click; the user can watch.
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
- For approvals over iMessage, the user replying "yes" or "approve" counts as approval of the latest plan."""


class ProposeArgs(Intent):
    dataset_upload_id: int | None = Field(None, description="Upload id of an attached dataset, if any.")
    render_from_workload_id: int | None = Field(
        None, description="Render jobs: the running desktop whose ~/Projects holds the scene."
    )
    blend_path: str | None = Field(None, description="Render jobs: the .blend inside ~/Projects; default newest.")


class EstimateRenderArgs(BaseModel):
    workload_id: int
    blend_path: str | None = Field(None, description="A .blend inside ~/Projects; default the newest one.")
    samples: int | None = Field(None, description="Override the scene's sample count, if the user asked.")
    frames: int = Field(1, description="How many frames the user plans to render.")


class WorkloadArg(BaseModel):
    workload_id: int


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
    async def propose_workload(**kwargs) -> str:
        upload = kwargs.pop("dataset_upload_id", None)
        source = kwargs.pop("render_from_workload_id", None)
        blend = kwargs.pop("blend_path", None)
        try:
            intent = Intent.model_validate(kwargs)
            return json.dumps(
                await app.propose(ctx.owner, ctx.conversation_id, intent, upload, render_from=source, blend_path=blend)
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
        try:
            run_id = await app.operate(ctx.owner, workload_id, goal)
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
            },
            default=str,
        )

    tools = [
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
            description="Have the desktop agent perform a task in a running desktop (GUI and terminal).",
            args_schema=OperateArgs,
        ),
        StructuredTool.from_function(
            coroutine=inspect_workload,
            name="inspect_workload",
            description="Status, recent events, latest training metrics, log tail, outputs and agent runs for one workload.",
            args_schema=WorkloadArg,
        ),
    ]
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
            f"- #{w['id']} {w['title']} ({w['kind']}): {w['status']}"
            for w in active
            if w["status"] in BILLABLE | {"stopped", "planned"}
        ]
        return "\n".join(live) or "- No active machines."

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
        result = await graph.ainvoke({"messages": [HumanMessage(text)]}, config)
        reply = next((m for m in reversed(result["messages"]) if isinstance(m, AIMessage) and m.content), None)
        content = reply.content if reply else ""
        if isinstance(content, list):
            content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
        return str(content).strip() or "Done."
