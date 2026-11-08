"""Anywhere as an MCP server, so Claude and other agents can plan and run compute as a tool.

Agents authenticate with personal access tokens that users mint in Settings. A token
is bound to one account and a set of scopes, and every tool call is re-authorized:
revoking a token or deactivating the account takes effect on the next request.

Spending is the line that matters. Without the `spend` scope a token can propose
plans but never approve or resume one, and its plans skip the user's auto-approve
threshold, so a person always confirms in the web app. Every call still goes through
`Anywhere`, so budget, ownership and lifecycle rules are the same as for the browser.

Transport is Streamable HTTP in stateless mode: each request is authenticated on its
own and no session state outlives it, which also makes restarts harmless.
"""

from __future__ import annotations

import asyncio
import hashlib
import math
import secrets
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

import httpx
import structlog
from fastapi import HTTPException
from mcp.server.mcpserver import Context, Image, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from pydantic import BaseModel, Field, ValidationError
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import Receive, Scope, Send

from . import budget
from .core import ActionError, Anywhere
from .ids import new_id
from .lifecycle import BILLABLE, Status
from .planner import Application, Intent, Preference
from .stdb import ReducerRejected, SpacetimeError
from .storage import StorageUnavailable

log = structlog.get_logger()

TOKEN_PREFIX = "awmcp_"
SCOPES: dict[str, str] = {
    "read": "See machines, plans, spend and the GPU catalog.",
    "plan": "Propose new machines and jobs, and cancel plans that haven't started.",
    "control": "Stop, save, delete and operate running machines.",
    "spend": "Approve plans and resume stopped machines. These cost money.",
}
DEFAULT_SCOPES: tuple[str, ...] = ("read", "plan", "control")

#: Upper bound for any single tool call. Long work (provisioning, the desktop agent)
#: runs in the background and is polled with `get_workload`.
CALL_TIMEOUT = 45.0
#: SATS-JSON ids are 53-bit (see ids.py); anything larger can't be a real id.
WorkloadId = Annotated[
    int, Field(ge=1, le=2**53, description="The workload id from propose_workload or list_workloads.")
]


# ── Tokens ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Principal:
    token_id: int
    digest: str
    owner: str
    name: str
    scopes: frozenset[str]
    #: Set for tokens issued through OAuth; revoking the grant revokes the token.
    grant_id: int | None = None


def digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def mint_token(app: Anywhere, owner: str, name: str, scopes: list[str], expires_days: int) -> tuple[str, dict]:
    """Create a token. The secret is returned once and only its hash is kept."""
    secret = TOKEN_PREFIX + secrets.token_urlsafe(32)
    now = datetime.now(UTC)
    record = {
        "id": new_id(),
        "owner": owner,
        "name": name,
        "scopes": sorted(set(scopes)),
        "hint": secret[: len(TOKEN_PREFIX) + 4],
        "created_at": now.isoformat(),
        "expires_at": (now + timedelta(days=expires_days)).isoformat(),
        "last_used_at": None,
        "conversation_id": None,
    }
    app.vault.put_mcp_token(digest(secret), record)
    return secret, public_token(record)


def public_token(record: dict) -> dict:
    """The parts of a token record that are safe to show the user."""
    return {k: record[k] for k in ("id", "name", "scopes", "hint", "created_at", "expires_at", "last_used_at")}


def authenticate(app: Anywhere, authorization: str | None) -> Principal | None:
    if not authorization or authorization[:7].lower() != "bearer ":
        return None
    token = authorization[7:].strip()
    # Cheap shape check first, so junk never reaches the vault.
    if not token.startswith(TOKEN_PREFIX) or not 20 <= len(token) <= 128:
        return None
    d = digest(token)
    record = app.vault.mcp_token(d)
    if not record:
        return None
    try:
        if datetime.fromisoformat(record["expires_at"]) <= datetime.now(UTC):
            return None
    except (KeyError, TypeError, ValueError):
        return None
    grant_id = record.get("grant_id")
    if grant_id is not None and not app.vault.section_get("oauth_grants", str(grant_id)):
        return None
    _touch(app, d, record)
    return Principal(record["id"], d, record["owner"], record["name"], frozenset(record.get("scopes", ())), grant_id)


_last_touch: dict[str, float] = {}


def _touch(app: Anywhere, d: str, record: dict) -> None:
    # Bound vault writes to one a minute per token; last-used is informational.
    if time.monotonic() - _last_touch.get(d, -math.inf) < 60:
        return
    _last_touch[d] = time.monotonic()
    try:
        now = datetime.now(UTC).isoformat()
        app.vault.update_mcp_token(d, last_used_at=now)
        if (grant_id := record.get("grant_id")) is not None:
            grant = app.vault.section_get("oauth_grants", str(grant_id))
            if grant:
                app.vault.section_put("oauth_grants", str(grant_id), {**grant, "last_used_at": now})
    except OSError as exc:
        log.warning("mcp.touch_failed", error=str(exc))


# ── HTTP endpoint ───────────────────────────────────────────────────────────


def _reject(status: int, message: str, **headers: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status, headers=headers)


class McpEndpoint:
    """ASGI endpoint for `/mcp`: feature flag, Origin check, bearer auth, then the SDK."""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        api = scope["app"]
        app: Anywhere = api.state.anywhere
        settings = app.settings
        headers = Headers(scope=scope)

        if not settings.mcp_enabled:
            return await _reject(404, "MCP is turned off on this server")(scope, receive, send)

        # Browsers send Origin; agents generally don't. A foreign Origin means a web page
        # is trying to drive the endpoint (DNS rebinding, CSRF) and is refused outright.
        origin = headers.get("origin")
        if origin and origin not in {settings.public_web_origin, *settings.cors_origins}:
            log.warning("mcp.origin_rejected", origin=origin[:200])
            return await _reject(403, "Origin not allowed")(scope, receive, send)

        principal = authenticate(app, headers.get("authorization"))
        if principal is None:
            challenge = 'Bearer realm="anywhere", error="invalid_token"'
            if settings.mcp_oauth_enabled:
                from .oauth import resource_metadata_url

                challenge += f', resource_metadata="{resource_metadata_url(settings.public_api_url)}"'
            return await _reject(
                401,
                "Sign in with OAuth, or use a token from Settings → Agents.",
                **{"WWW-Authenticate": challenge},
            )(scope, receive, send)

        try:
            _rate(f"mcp-http:{principal.token_id}", 120)
        except ToolError as exc:
            return await _reject(429, str(exc), **{"Retry-After": "60"})(scope, receive, send)

        server: MCPServer | None = getattr(api.state, "mcp", None)
        if server is None:
            return await _reject(503, "MCP is starting up. Try again shortly.")(scope, receive, send)
        scope.setdefault("state", {})["mcp_principal"] = principal
        await server.session_manager.handle_request(scope, receive, send)


def _rate(key: str, limit: int) -> None:
    from .api import rate_limit  # api imports this module; keep the import lazy.

    try:
        rate_limit(key, limit)
    except HTTPException as exc:
        raise ToolError("Too many requests. Wait a minute and try again.") from exc


# ── Tool plumbing ───────────────────────────────────────────────────────────


def _principal(ctx: Context) -> Principal:
    request = ctx.request_context.request
    state = getattr(request, "state", None)
    principal = getattr(state, "mcp_principal", None) if state is not None else None
    if not isinstance(principal, Principal):
        # Fail closed: no authenticated HTTP request, no access.
        raise ToolError("Not authenticated")
    return principal


async def _call(ctx: Context, scope: str, tool: str, fn, *, limit: int = 30):
    """Authorize, rate-limit, time-box and translate errors for one tool call.

    Users and agents only ever see a short, safe message. Internals (stack traces,
    database responses, provider output) stay in the server log.
    """
    p = _principal(ctx)
    app: Anywhere = ctx.request_context.request.app.state.anywhere
    if scope not in p.scopes:
        raise ToolError(
            f"This token doesn't have the '{scope}' permission ({SCOPES[scope]}) "
            "Ask the user to grant it in Settings → Agents, or to do this in the Anywhere web app."
        )
    _rate(f"mcp:{p.token_id}:{scope}", limit)
    bound = log.bind(tool=tool, token=p.token_id, owner=p.owner[:12])
    try:
        if not app.settings.stdb_ready:
            raise ToolError("Anywhere isn't connected to its database yet. Try again later.")
        acct = await app.store.account(p.owner)
        if not acct or not acct["activated"]:
            raise ToolError("This Anywhere account isn't active, so its agent tokens are paused.")
        result = await asyncio.wait_for(fn(app, p), CALL_TIMEOUT)
    except ToolError:
        raise
    except ActionError as exc:
        bound.info("mcp.refused", reason=str(exc))
        raise ToolError(str(exc)) from exc
    except ReducerRejected as exc:
        from .api import _clean_reducer_error

        bound.info("mcp.rejected", reason=str(exc))
        raise ToolError(_clean_reducer_error(str(exc))) from exc
    except ValidationError as exc:
        fields = sorted({".".join(str(x) for x in e["loc"]) for e in exc.errors()})
        raise ToolError(f"Invalid arguments: {', '.join(fields) or 'see the tool schema'}") from exc
    except StorageUnavailable as exc:
        raise ToolError("File storage isn't configured on this server yet.") from exc
    except TimeoutError as exc:
        bound.warning("mcp.timeout")
        raise ToolError("Anywhere took too long to respond. Check list_workloads before retrying.") from exc
    except (SpacetimeError, httpx.HTTPError) as exc:
        bound.warning("mcp.backend_unavailable", error=str(exc)[:300])
        raise ToolError("Anywhere's database is temporarily unavailable. Try again shortly.") from exc
    except Exception as exc:
        bound.exception("mcp.crashed")
        raise ToolError("Something went wrong inside Anywhere. The error has been logged.") from exc
    bound.info("mcp.ok")
    return result


async def _conversation(app: Anywhere, p: Principal) -> int:
    """One conversation per token (or per OAuth connection, whose access tokens rotate hourly),
    so the user can see in the web app what the agent asked for."""
    grant = app.vault.section_get("oauth_grants", str(p.grant_id)) if p.grant_id is not None else None
    record = grant if grant is not None else (app.vault.mcp_token(p.digest) or {})
    cid = record.get("conversation_id")
    if cid:
        return int(cid)
    cid = new_id()
    await app.store.upsert_conversation(cid, p.owner, f"Agent: {p.name}"[:60], "mcp")
    if grant is not None:
        app.vault.section_put("oauth_grants", str(p.grant_id), {**grant, "conversation_id": cid})
    else:
        app.vault.update_mcp_token(p.digest, conversation_id=cid)
    return cid


async def _note(app: Anywhere, p: Principal, workload_id: int, text: str) -> None:
    """Leave an audit line in the token's conversation. Never fails the call."""
    try:
        cid = await _conversation(app, p)
        await app.store.append_message(cid, "assistant", "text", f"{p.name} (MCP): {text}", workload_id, "mcp")
    except Exception as exc:
        log.warning("mcp.note_failed", error=str(exc)[:300])


def _workload_view(app: Anywhere, w: dict) -> dict[str, Any]:
    status = w["status"]
    view = {
        "workload_id": int(w["id"]),
        "title": w["title"],
        "kind": w["kind"],
        "status": status,
        "detail": w.get("statusDetail") or "",
        "gpu": w.get("gpuName") or "",
        "hourly": budget.usd(int(w.get("hourlyCents") or 0)),
        "spent": budget.usd(int(w.get("accruedCents") or 0)),
        "estimate_low": budget.usd(int(w.get("estLowCents") or 0)),
        "estimate_high": budget.usd(int(w.get("estHighCents") or 0)),
        "billing": status in BILLABLE,
        "needs_approval": status == Status.PLANNED,
        "web_url": f"{app.settings.public_web_origin.rstrip('/')}/w/{w['id']}",
    }
    created = w.get("createdAt")
    if isinstance(created, datetime):
        view["created_at"] = created.isoformat()
    return view


async def _agent_history(app: Anywhere, workload_id: int, steps: int = 15) -> dict | None:
    """The latest desktop-agent run and its last few steps. History is best-effort: an older
    database without the worker views still answers get_workload, just without it."""
    try:
        runs = await app.store.agent_runs(workload_id)
        if not runs:
            return None
        latest = runs[0]
        rows = await app.store.agent_steps(int(latest["id"]))
    except (SpacetimeError, httpx.HTTPError) as exc:
        log.info("mcp.agent_history_unavailable", error=str(exc)[:200])
        return None
    return {
        "run_id": int(latest["id"]),
        "goal": latest["goal"],
        "status": latest["status"],
        "result": latest.get("result") or "",
        "total_runs": len(runs),
        "steps": [
            {
                "seq": int(r["seq"]),
                "kind": r["kind"],
                "summary": r["summary"],
                "has_screenshot": bool(r["screenshotKey"]),
            }
            for r in rows[-steps:]
        ],
    }


async def _owned(app: Anywhere, p: Principal, workload_id: int) -> dict:
    return await app.owned(p.owner, workload_id)


# ── Server ──────────────────────────────────────────────────────────────────

INSTRUCTIONS = """Anywhere provisions real NVIDIA GPU machines (interactive Linux desktops with Blender,
VS Code, JupyterLab or a terminal, and LoRA/QLoRA fine-tuning jobs) and can operate them.

How to use it well:
- Call propose_workload to get a validated plan with hardware and a cost range. Never invent
  hardware or prices; they come from this server.
- Machines cost real money. Show the user the plan and cost, and only call approve_workload after
  they explicitly agree to that specific plan. If your token lacks the 'spend' permission, send them
  the web_url to approve it there.
- Provisioning takes several minutes and happens in the background. Poll get_workload rather than
  re-proposing.
- stop_workload saves files and pauses billing. Prefer it over delete_workload, and confirm with the
  user before deleting anything."""


class ProposeIn(BaseModel):
    kind: Literal["desktop", "fine_tune"] = Field(description="An interactive desktop, or a fine-tuning job.")
    summary: str = Field(min_length=3, max_length=500, description="One sentence restating the user's goal.")
    application: Application | None = Field(None, description="Desktop application. Defaults to a terminal.")
    model_params_billions: float | None = Field(None, ge=0, le=1000, description="Model size, e.g. 7 for 7B.")
    epochs: int | None = Field(None, ge=1, le=20)
    session_hours: float | None = Field(None, ge=0, le=24, description="How long the user expects to work.")
    preference: Preference | None = None
    max_budget_usd: float | None = Field(None, ge=0, le=1000)
    dataset_upload_id: int | None = Field(None, ge=1, le=2**53, description="Upload id of a dataset, for fine-tuning.")


def build_server() -> MCPServer:
    server = MCPServer(
        name="anywhere",
        title="Anywhere",
        description="Plan, run and operate NVIDIA GPU machines.",
        instructions=INSTRUCTIONS,
        version="0.1.0",
    )
    read = ToolAnnotations(readOnlyHint=True, openWorldHint=False)

    @server.tool(title="Account and budget", annotations=read)
    async def get_account(ctx: Context) -> dict:
        """Show this account's spending limits, this month's spend and what the token may do."""

        async def run(app: Anywhere, p: Principal):
            acct = await app.account(p.owner)
            spend = await app.spend_snapshot(p.owner)
            return {
                "activated": bool(acct["activated"]),
                "monthly_cap": budget.usd(int(acct["monthlyCapCents"])),
                "spent_this_month": budget.usd(spend.account_month_cents),
                "auto_approve_up_to": budget.usd(int(acct["approvalThresholdCents"])),
                "provisioning_mode": app.settings.provisioning_mode.value,
                "token_permissions": sorted(p.scopes),
            }

        return await _call(ctx, "read", "get_account", run, limit=60)

    @server.tool(title="GPU catalog", annotations=read)
    async def get_catalog(ctx: Context) -> dict:
        """List the GPU machines Anywhere can provision, with hourly prices."""

        async def run(app: Anywhere, _p: Principal):
            await app.refresh_prices()
            return {"offers": [o.public() for o in app.catalog.offers()]}

        return await _call(ctx, "read", "get_catalog", run, limit=30)

    @server.tool(title="List machines", annotations=read)
    async def list_workloads(
        ctx: Context,
        include_finished: Annotated[
            bool, Field(description="Include terminated, cancelled and finished work.")
        ] = False,
    ) -> dict:
        """List the user's machines, jobs and pending plans, newest first, with status and spend."""

        async def run(app: Anywhere, p: Principal):
            done = {Status.TERMINATED, Status.CANCELLED, Status.SUCCEEDED, Status.FAILED}
            rows = [w for w in await app.store.workloads() if w["owner"] == p.owner]
            if not include_finished:
                rows = [w for w in rows if w["status"] not in done]
            rows.sort(key=lambda w: w["createdAt"], reverse=True)
            return {"workloads": [_workload_view(app, w) for w in rows[:25]]}

        return await _call(ctx, "read", "list_workloads", run, limit=60)

    @server.tool(title="Machine status", annotations=read)
    async def get_workload(ctx: Context, workload_id: WorkloadId) -> dict:
        """Get one machine's status and spend, plus what the desktop agent did in its latest run."""

        async def run(app: Anywhere, p: Principal):
            w = await _owned(app, p, workload_id)
            view = _workload_view(app, w)
            view["controller"] = w.get("controller", "")
            view["agent_running"] = app.supervisor.agent_running(int(w["id"]))
            view["busy"] = app.supervisor.busy(int(w["id"]))
            view["agent"] = await _agent_history(app, int(w["id"]))
            return view

        return await _call(ctx, "read", "get_workload", run, limit=120)

    @server.tool(title="Desktop screenshot", annotations=read)
    async def get_desktop_screenshot(ctx: Context, workload_id: WorkloadId) -> Image:
        """Take a live screenshot of a running desktop, to see what's on screen right now.

        MCP can't carry the live video stream; for that, open the desktop's web_url."""

        async def run(app: Anywhere, p: Principal):
            w = await _owned(app, p, workload_id)
            if w["kind"] != "desktop" or w["status"] != Status.RUNNING:
                raise ActionError("Screenshots need a running desktop")
            try:
                # Pooled tunnel, a few seconds of frame reuse, and one capture shared
                # by concurrent callers (agents are told to poll this).
                frame = await app.supervisor.shots.frame(
                    int(w["id"]), app.supervisor.remote(w), app.vault.agent_token(int(w["id"]))
                )
            except TimeoutError:
                raise
            except Exception as exc:
                log.warning("mcp.screenshot_failed", workload=workload_id, error=str(exc)[:300])
                raise ActionError("Couldn't reach the desktop to take a screenshot. Try again in a moment.") from exc
            return Image(data=frame.jpeg, format="jpeg")

        return await _call(ctx, "read", "get_desktop_screenshot", run, limit=10)

    @server.tool(title="Propose a machine", annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False))
    async def propose_workload(ctx: Context, request: ProposeIn) -> dict:
        """Turn what the user wants into a validated plan with hardware and a cost range.

        Nothing is started or billed. The plan waits for approval: with the 'spend' permission
        you may approve it after the user agrees; otherwise the user approves it in the web app."""

        async def run(app: Anywhere, p: Principal):
            data = request.model_dump(exclude={"dataset_upload_id"})
            intent = Intent.model_validate(data)
            cid = await _conversation(app, p)
            result = await app.propose(
                p.owner, cid, intent, request.dataset_upload_id, auto_approve="spend" in p.scopes
            )
            if result.get("ok") and result.get("workload_id"):
                w = await app.store.workload(int(result["workload_id"]))
                if w:
                    result["workload"] = _workload_view(app, w)
                if not result.get("auto_approved"):
                    result["next_step"] = (
                        "Show the user the plan and cost. After they agree, call approve_workload."
                        if "spend" in p.scopes
                        else "Ask the user to approve this plan in the Anywhere web app (workload.web_url)."
                    )
            return result

        return await _call(ctx, "plan", "propose_workload", run, limit=10)

    @server.tool(title="Cancel a plan", annotations=ToolAnnotations(destructiveHint=False, idempotentHint=True))
    async def cancel_plan(ctx: Context, workload_id: WorkloadId) -> dict:
        """Discard a plan that hasn't been approved yet. Nothing was billed for it."""

        async def run(app: Anywhere, p: Principal):
            await app.cancel(p.owner, workload_id)
            await _note(app, p, workload_id, "cancelled the plan.")
            return {"ok": True, "status": Status.CANCELLED}

        return await _call(ctx, "plan", "cancel_plan", run)

    @server.tool(
        title="Approve a plan (spends money)",
        annotations=ToolAnnotations(destructiveHint=False, idempotentHint=False, openWorldHint=True),
    )
    async def approve_workload(ctx: Context, workload_id: WorkloadId) -> dict:
        """Start a planned machine. This provisions real hardware and costs the user real money.

        Only call this after the user has explicitly agreed to this specific plan and its cost."""

        async def run(app: Anywhere, p: Principal):
            await app.approve(p.owner, workload_id)
            await _note(app, p, workload_id, "approved the plan.")
            return {"ok": True, "message": "Approved. Provisioning takes a few minutes; poll get_workload."}

        return await _call(ctx, "spend", "approve_workload", run, limit=5)

    @server.tool(title="Stop a machine", annotations=ToolAnnotations(destructiveHint=False, idempotentHint=True))
    async def stop_workload(ctx: Context, workload_id: WorkloadId) -> dict:
        """Save project files and stop a running machine. Billing pauses; desktops can be resumed."""

        async def run(app: Anywhere, p: Principal):
            await app.stop(p.owner, workload_id)
            await _note(app, p, workload_id, "stopped the machine.")
            return {"ok": True, "message": "Stopping. Files are saved first."}

        return await _call(ctx, "control", "stop_workload", run)

    @server.tool(
        title="Resume a desktop (spends money)",
        annotations=ToolAnnotations(destructiveHint=False, openWorldHint=True),
    )
    async def resume_desktop(ctx: Context, workload_id: WorkloadId) -> dict:
        """Restart a stopped desktop with its saved files. Billing resumes, so this costs real money."""

        async def run(app: Anywhere, p: Principal):
            await app.resume(p.owner, workload_id)
            await _note(app, p, workload_id, "resumed the desktop.")
            return {"ok": True, "message": "Resuming. It takes a few minutes; poll get_workload."}

        return await _call(ctx, "spend", "resume_desktop", run, limit=5)

    @server.tool(title="Save project files", annotations=ToolAnnotations(destructiveHint=False, idempotentHint=True))
    async def save_project(ctx: Context, workload_id: WorkloadId) -> dict:
        """Snapshot a running desktop's project files to durable storage."""

        async def run(app: Anywhere, p: Principal):
            await app.save(p.owner, workload_id)
            return {"ok": True, "message": "Saving project files."}

        return await _call(ctx, "control", "save_project", run)

    @server.tool(title="Delete a machine", annotations=ToolAnnotations(destructiveHint=True, idempotentHint=True))
    async def delete_workload(
        ctx: Context,
        workload_id: WorkloadId,
        confirm: Annotated[bool, Field(description="Must be true. Set it only after the user confirmed deletion.")],
    ) -> dict:
        """Permanently delete a machine. Project files are saved first if it's running.

        Confirm with the user before calling. Prefer stop_workload when they only want to pause."""

        async def run(app: Anywhere, p: Principal):
            if confirm is not True:
                raise ToolError("Deletion needs confirm=true, after the user has agreed to it.")
            await app.terminate(p.owner, workload_id)
            await _note(app, p, workload_id, "deleted the machine.")
            return {"ok": True, "message": "Deleting the machine."}

        return await _call(ctx, "control", "delete_workload", run, limit=10)

    @server.tool(title="Operate a desktop", annotations=ToolAnnotations(destructiveHint=False, openWorldHint=True))
    async def operate_desktop(
        ctx: Context,
        workload_id: WorkloadId,
        goal: Annotated[
            str, Field(min_length=3, max_length=2000, description="A precise, self-contained task for the desktop.")
        ],
    ) -> dict:
        """Have Anywhere's computer-use agent carry out a task on a running desktop (GUI and terminal).

        It runs in the background. Poll get_workload (agent_running) and watch at web_url."""

        async def run(app: Anywhere, p: Principal):
            try:
                run_id = await app.operate(p.owner, workload_id, goal)
            except RuntimeError as exc:
                raise ActionError(str(exc)) from exc
            await _note(app, p, workload_id, f"asked the desktop agent to: {goal[:300]}")
            w = await app.store.workload(workload_id)
            return {"ok": True, "run_id": run_id, "web_url": _workload_view(app, w)["web_url"] if w else None}

        return await _call(ctx, "control", "operate_desktop", run, limit=10)

    @server.tool(
        title="Stop the desktop agent", annotations=ToolAnnotations(destructiveHint=False, idempotentHint=True)
    )
    async def stop_desktop_agent(ctx: Context, workload_id: WorkloadId) -> dict:
        """Stop the computer-use agent on a desktop and hand control back to the user."""

        async def run(app: Anywhere, p: Principal):
            await _owned(app, p, workload_id)
            await app.supervisor.stop_agent(workload_id)
            await app.store.set_controller(workload_id, "user")
            return {"ok": True}

        return await _call(ctx, "control", "stop_desktop_agent", run)

    # Build the transport now so the session manager exists for the app's lifespan.
    server.streamable_http_app(
        stateless_http=True,
        json_response=True,
        max_request_body_size=256 * 1024,
        # Origin checks happen in McpEndpoint against the configured web origins; the SDK's
        # localhost-only Host allowlist would reject every request behind Caddy.
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )
    return server


__all__ = ["DEFAULT_SCOPES", "SCOPES", "McpEndpoint", "authenticate", "build_server", "mint_token", "public_token"]
