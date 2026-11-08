"""HTTP API. Commands come in here; state flows back out through SpacetimeDB."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import hmac
import json
import secrets
import time
from collections import defaultdict, deque
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Literal
from urllib.parse import urlparse

import structlog
import websockets
from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field
from starlette.routing import Route

from . import budget, sharing
from .agent import Agent, TurnContext
from .auth import Identity, require_bridge
from .brev import BrevCLI
from .config import Settings, get_settings
from .core import ActionError, Anywhere, parse_link_code
from .ids import new_id
from .lifecycle import Status
from .llm import ModelUnavailable
from .mcp_server import DEFAULT_SCOPES, SCOPES, McpEndpoint, build_server, mint_token, public_token
from .oauth import AnywhereOAuth, grants_for
from .oauth import routes as oauth_routes
from .photon import PhotonClient, PhotonError, normalize_phone
from .planner import SUPPORTED_APPS, Application, Intent, Preference
from .stdb import ReducerRejected, SpacetimeClient
from .storage import Storage, StorageUnavailable, safe_filename
from .store import Store, plain_dashes
from .training import DatasetError, inspect_dataset
from .vault import Vault

log = structlog.get_logger()


# ── Wiring ──────────────────────────────────────────────────────────────────


def build(settings: Settings) -> tuple[Anywhere, Agent]:
    token = settings.spacetime_worker_token.get_secret_value() if settings.spacetime_worker_token else None
    worker = SpacetimeClient(settings.spacetime_host, settings.spacetime_database, token)
    public = SpacetimeClient(settings.spacetime_host, settings.spacetime_database)
    app = Anywhere(
        settings=settings,
        store=Store(worker),
        public_stdb=public,
        brev=BrevCLI(
            settings.brev_binary,
            settings.brev_api_key.get_secret_value() if settings.brev_api_key else None,
            settings.provisioning_mode,
        ),
        storage=Storage(settings),
        vault=Vault(settings.data_dir / "vault.json"),
    )
    return app, Agent(app)


@asynccontextmanager
async def lifespan(api: FastAPI):
    settings: Settings = api.state.settings
    app, agent = build(settings)
    api.state.anywhere = app
    api.state.agent = agent
    api.state.ticket_key = secrets.token_bytes(32)
    await agent.start()
    app.readiness.start()
    async with AsyncExitStack() as stack:
        if settings.mcp_enabled:
            # The SDK's session manager runs once per instance, so each lifespan builds its own.
            api.state.mcp = build_server()
            await stack.enter_async_context(api.state.mcp.session_manager.run())
        if settings.stdb_ready:
            await app.supervisor.recover()
            app.supervisor.start_guard()
        else:
            log.warning("startup.spacetime_unconfigured", hint="Set SPACETIME_WORKER_TOKEN; see README")
        log.info("startup.ready", integrations=settings.integrations(), mode=settings.provisioning_mode.value)
        yield
        await app.readiness.stop()
        await app.supervisor.shutdown()
        await agent.close()


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    api = FastAPI(title="Anywhere control plane", version="0.1.0", lifespan=lifespan)
    api.state.settings = settings
    api.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.public_web_origin, *settings.cors_origins],
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "X-Anywhere-Identity"],
    )

    @api.exception_handler(ActionError)
    async def _action_error(_: Request, exc: ActionError):
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @api.exception_handler(ReducerRejected)
    async def _rejected(_: Request, exc: ReducerRejected):
        return JSONResponse({"detail": _clean_reducer_error(str(exc))}, status_code=409)

    @api.exception_handler(StorageUnavailable)
    async def _no_storage(_: Request, exc: StorageUnavailable):
        return JSONResponse({"detail": str(exc)}, status_code=503)

    api.include_router(_routes())
    api.router.routes.append(Route("/mcp", McpEndpoint(), methods=["GET", "POST", "DELETE"]))
    api.state.oauth = None
    if settings.mcp_enabled and settings.mcp_oauth_enabled:
        provider = AnywhereOAuth(api)
        try:
            api.router.routes.extend(oauth_routes(api, provider, settings.public_api_url))
            api.state.oauth = provider
        except ValueError as exc:
            # A bad PUBLIC_API_URL (say, plain HTTP on a public host) disables OAuth, not the service.
            settings.mcp_oauth_enabled = False
            log.warning("startup.oauth_disabled", reason=str(exc), public_api_url=settings.public_api_url)
    return api


def _clean_reducer_error(message: str) -> str:
    return message.split("rejected:", 1)[-1].strip() or "Request rejected"


def anywhere(request: Request) -> Anywhere:
    return request.app.state.anywhere


# ── Rate limiting ───────────────────────────────────────────────────────────

_hits: dict[str, deque[float]] = defaultdict(deque)


_last_sweep = 0.0


def rate_limit(key: str, limit: int, window: float = 60) -> None:
    global _last_sweep
    now = time.monotonic()
    # Keys (per owner, token or IP) used to accumulate forever; drop idle ones.
    if now - _last_sweep > window:
        _last_sweep = now
        for k in [k for k, q in _hits.items() if not q or q[-1] < now - window]:
            del _hits[k]
    q = _hits[key]
    while q and q[0] < now - window:
        q.popleft()
    if len(q) >= limit:
        raise HTTPException(429, "Slow down a little and try again in a moment")
    q.append(now)


# ── VNC tickets ─────────────────────────────────────────────────────────────


def issue_ticket(key: bytes, workload_id: int, owner: str, ttl: int = 60) -> str:
    body = json.dumps({"w": workload_id, "o": owner, "e": int(time.time()) + ttl}).encode()
    sig = hmac.new(key, body, hashlib.sha256).digest()
    return (
        base64.urlsafe_b64encode(body).decode().rstrip("=") + "." + base64.urlsafe_b64encode(sig).decode().rstrip("=")
    )


def read_ticket(key: bytes, ticket: str) -> dict | None:
    try:
        b, s = ticket.split(".")
        body = base64.urlsafe_b64decode(b + "=" * (-len(b) % 4))
        sig = base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    except ValueError:
        return None
    if not hmac.compare_digest(hmac.new(key, body, hashlib.sha256).digest(), sig):
        return None
    data = json.loads(body)
    return data if data["e"] >= time.time() else None


# ── Routes ──────────────────────────────────────────────────────────────────


class ChatIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    conversation_id: int | None = None
    #: Chatting from a desktop or job page: the agent focuses on that workload.
    workload_id: int | None = None
    upload_ids: list[int] = Field(default_factory=list, max_length=4)


class PlanIn(BaseModel):
    """A template launch: everything the planner needs, without the language model."""

    kind: Literal["desktop", "fine_tune"]
    application: Application | None = None
    session_hours: float | None = Field(None, gt=0, le=24)
    model_params_billions: float | None = Field(None, gt=0, le=100)
    epochs: int | None = Field(None, ge=1, le=20)
    upload_id: int | None = None
    preference: Preference | None = None
    summary: str | None = Field(None, max_length=500)
    conversation_id: int | None = None

    def intent(self) -> Intent:
        summary = (self.summary or "").strip() or _default_summary(self)
        return Intent(
            kind=self.kind,
            summary=summary,
            application=self.application if self.kind == "desktop" else None,
            model_params_billions=self.model_params_billions,
            epochs=self.epochs,
            session_hours=self.session_hours,
            preference=self.preference,
        )


def _default_summary(body: PlanIn) -> str:
    if body.kind == "desktop":
        return f"{SUPPORTED_APPS.get(body.application or 'terminal', 'Linux')} desktop"
    size = f"{body.model_params_billions:g}B " if body.model_params_billions else ""
    return f"Fine-tune a {size}language model"


class ActivateIn(BaseModel):
    code: str = Field(min_length=1, max_length=128)


class ShareIn(BaseModel):
    hours: float = Field(4, ge=0.25, le=24)


class GoalIn(BaseModel):
    goal: str = Field(min_length=1, max_length=2000)


class RenderEstimateIn(BaseModel):
    blend_path: str | None = Field(None, max_length=300)
    samples: int | None = Field(None, ge=1, le=65536)
    frames: int = Field(1, ge=1, le=10000)


class UploadIn(BaseModel):
    filename: str = Field(min_length=1, max_length=200)
    content_type: str = Field(default="application/octet-stream", max_length=100)
    size: int = Field(gt=0)


class LinkIn(BaseModel):
    phone: str = Field(min_length=7, max_length=24)


class McpTokenIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    scopes: list[str] = Field(default_factory=lambda: list(DEFAULT_SCOPES), min_length=1, max_length=len(SCOPES))
    expires_days: int = Field(default=90, ge=1)


class OAuthDecisionIn(BaseModel):
    approve: bool
    scopes: list[str] | None = Field(default=None, max_length=len(SCOPES))


class InboundIn(BaseModel):
    handle: str = Field(min_length=3, max_length=64)
    text: str = Field(max_length=4000)
    message_id: str = Field(min_length=1, max_length=128)


_turn_locks: dict[int, list] = {}  # conversation id -> [lock, users]
_seen_inbound: deque[str] = deque(maxlen=2048)
_background: set[asyncio.Task] = set()


def _routes():
    from fastapi import APIRouter

    r = APIRouter()

    @r.get("/health")
    async def health(request: Request):
        """Liveness plus integration readiness. `integrations[x]` is true only when x
        is configured and its latest background check (every 5 min) didn't fail;
        `checks` carries the per-integration status and reason."""
        s: Settings = request.app.state.settings
        return {"ok": True, "mode": s.provisioning_mode.value, **request.app.state.anywhere.readiness.snapshot()}

    @r.get("/v1/catalog")
    async def catalog(app: Anywhere = Depends(anywhere)):
        await app.refresh_prices()
        return {"offers": [o.public() for o in app.catalog.offers()]}

    # Account ---------------------------------------------------------------

    @r.get("/v1/costs")
    async def costs(owner: str = Identity, app: Anywhere = Depends(anywhere)):
        rate_limit(f"costs:{owner}", 60)
        return await app.costs(owner)

    @r.post("/v1/account/activate")
    async def activate(body: ActivateIn, owner: str = Identity, app: Anywhere = Depends(anywhere)):
        rate_limit(f"activate:{owner}", 5)
        s = app.settings
        expected = s.invite_code.get_secret_value() if s.invite_code else None
        if expected is None and s.environment != "development":
            raise HTTPException(403, "Activation is closed")
        if expected is not None and not hmac.compare_digest(expected, body.code.strip()):
            raise HTTPException(403, "That invite code isn't valid")
        await app.account(owner)
        await app.store.activate_account(owner, True)
        return {"ok": True}

    # Chat ------------------------------------------------------------------

    @r.post("/v1/chat")
    async def chat(body: ChatIn, request: Request, owner: str = Identity, app: Anywhere = Depends(anywhere)):
        rate_limit(f"chat:{owner}", 20)
        await app.account(owner)
        cid = body.conversation_id
        if body.workload_id is not None:
            # A workload's sidebar continues the conversation that created it.
            w = await app.owned(owner, body.workload_id)
            cid = int(w["conversationId"]) or app.vault.get(0).get(f"workload-chat:{w['id']}")
            if not cid:
                cid = new_id()
                await app.store.upsert_conversation(cid, owner, w["title"], "web")
                app.vault.update(0, **{f"workload-chat:{w['id']}": cid})
        elif cid is None:
            cid = new_id()
            await app.store.upsert_conversation(cid, owner, _title(body.text), "web")
        elif not await app.store.conversation_owned(cid, owner):
            raise ActionError("Conversation not found")
        text = body.text.strip()
        for uid in body.upload_ids:
            up = app.vault.upload(uid)
            if up and up["owner"] == owner:
                p = up["profile"]
                text += (
                    f"\n\n[Attached dataset: {up['name']} (upload id {uid}), ~{p['rows']:,} rows, "
                    f"{p['schema']} format, {up['size'] / 1e6:.1f} MB]"
                )
        await app.store.append_message(cid, "user", "text", text, 0, "web")
        agent: Agent = request.app.state.agent
        asyncio.create_task(_agent_turn(app, agent, TurnContext(owner, cid, "web", body.workload_id), text))
        return {"conversation_id": cid}

    # Workloads -------------------------------------------------------------

    @r.post("/v1/workloads/plan")
    async def plan_workload(body: PlanIn, owner: str = Identity, app: Anywhere = Depends(anywhere)):
        """Template launcher: plan a desktop or fine-tune without Nemotron."""
        rate_limit(f"plan:{owner}", 20)
        try:
            intent = body.intent()
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        return await app.plan_direct(
            owner, intent, conversation_id=body.conversation_id, upload_id=body.upload_id, note=body.summary
        )

    actions = {
        "approve": lambda a, o, w: a.approve(o, w),
        "cancel": lambda a, o, w: a.cancel(o, w),
        "stop": lambda a, o, w: a.stop(o, w),
        "resume": lambda a, o, w: a.resume(o, w),
        "save": lambda a, o, w: a.save(o, w),
        "delete": lambda a, o, w: a.terminate(o, w),
    }

    # One route per action, not `/{action}`: a catch-all path here would also capture
    # POSTs meant for later routes like /share and /render-estimate.
    def action_route(name: str):
        async def workload_action(workload_id: int, owner: str = Identity, app: Anywhere = Depends(anywhere)):
            rate_limit(f"action:{owner}", 30)
            await actions[name](app, owner, workload_id)
            return {"ok": True}

        return workload_action

    for name in actions:
        r.add_api_route(f"/v1/workloads/{{workload_id}}/{name}", action_route(name), methods=["POST"])

    @r.post("/v1/workloads/{workload_id}/render-estimate")
    async def render_estimate(
        workload_id: int, body: RenderEstimateIn, owner: str = Identity, app: Anywhere = Depends(anywhere)
    ):
        rate_limit(f"render-estimate:{owner}", 6)
        return await app.estimate_render(owner, workload_id, body.blend_path, body.samples, body.frames)

    @r.get("/v1/workloads/{workload_id}/agent-runs/{run_id}/replay")
    async def agent_replay(workload_id: int, run_id: int, owner: str = Identity, app: Anywhere = Depends(anywhere)):
        rate_limit(f"replay:{owner}", 60)
        return await app.replay(owner, workload_id, run_id)

    @r.post("/v1/workloads/{workload_id}/agent-runs/{run_id}/timelapse")
    async def agent_timelapse(workload_id: int, run_id: int, owner: str = Identity, app: Anywhere = Depends(anywhere)):
        rate_limit(f"timelapse:{owner}", 6)
        return await app.replay_gif(owner, workload_id, run_id)

    @r.post("/v1/workloads/{workload_id}/agent/run")
    async def agent_run(workload_id: int, body: GoalIn, owner: str = Identity, app: Anywhere = Depends(anywhere)):
        rate_limit(f"agent:{owner}", 10)
        try:
            run_id = await app.operate(owner, workload_id, body.goal)
        except RuntimeError as exc:
            raise ActionError(str(exc)) from exc
        return {"run_id": run_id}

    @r.post("/v1/workloads/{workload_id}/agent/stop")
    async def agent_stop(
        workload_id: int, pause: bool = False, owner: str = Identity, app: Anywhere = Depends(anywhere)
    ):
        # pause=true is the user taking over: the run can be handed back and resumed.
        await app.halt_agent(owner, workload_id, pause=pause)
        return {"ok": True}

    @r.post("/v1/workloads/{workload_id}/agent/resume")
    async def agent_resume(workload_id: int, owner: str = Identity, app: Anywhere = Depends(anywhere)):
        run_id = await app.resume_agent(owner, workload_id)
        return {"run_id": run_id}

    # Desktop stream --------------------------------------------------------

    @r.post("/v1/desktops/{workload_id}/session")
    async def desktop_session(
        workload_id: int, request: Request, owner: str = Identity, app: Anywhere = Depends(anywhere)
    ):
        w = await app.owned(owner, workload_id)
        if w["kind"] != "desktop" or w["status"] != Status.RUNNING:
            raise ActionError("The desktop isn't running")
        return {"ticket": issue_ticket(request.app.state.ticket_key, workload_id, owner)}

    @r.websocket("/v1/desktops/{workload_id}/vnc")
    async def desktop_vnc(ws: WebSocket, workload_id: int, ticket: str):
        app: Anywhere = ws.app.state.anywhere
        claims = read_ticket(ws.app.state.ticket_key, ticket)
        if not claims or claims["w"] != workload_id:
            await ws.close(code=4401)
            return
        w = await app.store.workload(workload_id)
        if not w or w["owner"] != claims["o"] or w["status"] != Status.RUNNING:
            await ws.close(code=4404)
            return
        await ws.accept(subprotocol="binary" if "binary" in ws.scope.get("subprotocols", []) else None)
        try:
            port = await app.supervisor.vnc.port_for(workload_id, app.supervisor.remote(w))
            async with websockets.connect(
                f"ws://127.0.0.1:{port}/websockify", subprotocols=["binary"], max_size=None, open_timeout=15
            ) as upstream:
                await _relay(ws, upstream, lambda: app.store.record_usage(workload_id, int(w["accruedCents"]), True))
        except (WebSocketDisconnect, websockets.ConnectionClosed):
            pass
        except Exception as exc:
            log.warning("vnc.proxy_failed", workload=workload_id, error=str(exc))
            await ws.close(code=1011)

    # Watch links -----------------------------------------------------------

    @r.post("/v1/workloads/{workload_id}/share")
    async def create_share(workload_id: int, body: ShareIn, owner: str = Identity, app: Anywhere = Depends(anywhere)):
        rate_limit(f"share:{owner}", 10)
        made = await app.create_share(owner, workload_id, body.hours)
        await _drop_watchers(made.pop("replaced"))
        return made

    @r.get("/v1/workloads/{workload_id}/share")
    async def share_status(workload_id: int, owner: str = Identity, app: Anywhere = Depends(anywhere)):
        return await app.share_status(owner, workload_id)

    @r.delete("/v1/workloads/{workload_id}/share")
    async def revoke_share(workload_id: int, owner: str = Identity, app: Anywhere = Depends(anywhere)):
        await _drop_watchers(await app.revoke_share(owner, workload_id))
        return {"ok": True}

    @r.get("/v1/watch/{token}")
    async def watch(token: str, app: Anywhere = Depends(anywhere)):
        rate_limit(f"watch:{sharing.digest(token)}", 240)
        try:
            return await app.watch_view(token)
        except ActionError as exc:
            raise HTTPException(404, str(exc)) from exc

    @r.websocket("/v1/watch/{token}/vnc")
    async def watch_vnc(ws: WebSocket, token: str):
        app: Anywhere = ws.app.state.anywhere
        try:
            rec, w = await app.watched(token)
        except ActionError:
            await ws.close(code=4404)
            return
        key = sharing.digest(token)
        viewers = _watchers.setdefault(key, set())
        if w["status"] != Status.RUNNING or len(viewers) >= MAX_WATCHERS:
            await ws.close(code=4429 if w["status"] == Status.RUNNING else 4404)
            return
        await ws.accept(subprotocol="binary" if "binary" in ws.scope.get("subprotocols", []) else None)
        viewers.add(ws)
        try:
            port = await app.supervisor.vnc.watch.port_for(int(w["id"]), app.supervisor.remote(w))
            async with websockets.connect(
                f"ws://127.0.0.1:{port}/websockify", subprotocols=["binary"], max_size=None, open_timeout=15
            ) as upstream:
                # Watching doesn't count as using the desktop, so it still idle-stops.
                await asyncio.wait_for(_relay(ws, upstream, _no_touch), timeout=sharing.seconds_left(rec))
        except (WebSocketDisconnect, websockets.ConnectionClosed, TimeoutError):
            with contextlib.suppress(Exception):
                await ws.close(code=1001)
        except Exception as exc:
            log.warning("watch.proxy_failed", workload=w["id"], error=str(exc))
            with contextlib.suppress(Exception):
                await ws.close(code=1011)
        finally:
            viewers.discard(ws)
            if not viewers:
                _watchers.pop(key, None)

    # Uploads & files -------------------------------------------------------

    @r.post("/v1/uploads")
    async def create_upload(body: UploadIn, owner: str = Identity, app: Anywhere = Depends(anywhere)):
        if body.size > app.settings.max_upload_bytes:
            raise HTTPException(413, "That file is too large")
        uid = new_id()
        key = Storage.upload_key(owner, uid, body.filename)
        return {"upload_id": uid, "key": key, "put_url": app.storage.presign_put(key, body.content_type)}

    @r.post("/v1/uploads/{upload_id}/complete")
    async def complete_upload(upload_id: int, body: UploadIn, owner: str = Identity, app: Anywhere = Depends(anywhere)):
        key = Storage.upload_key(owner, upload_id, body.filename)
        head = await app.storage.head(key)
        if not head:
            raise HTTPException(404, "Upload not found")
        size = int(head["ContentLength"])
        sample = await app.storage.read_range(key, 1024 * 1024)
        try:
            profile = inspect_dataset(body.filename, sample, size)
        except (DatasetError, UnicodeDecodeError) as exc:
            raise HTTPException(422, str(exc)) from exc
        app.register_upload(owner, upload_id, key, safe_filename(body.filename), size, profile)
        return {"upload_id": upload_id, "profile": profile.model_dump(by_alias=True)}

    @r.get("/v1/files")
    async def file_url(key: str, download: bool = False, owner: str = Identity, app: Anywhere = Depends(anywhere)):
        if not Storage.owns(owner, key):
            raise HTTPException(404, "File not found")
        url = app.storage.presign_get(key, filename=key.rsplit("/", 1)[-1] if download else None)
        return RedirectResponse(url) if download else {"url": url}

    # MCP tokens ------------------------------------------------------------
    # Managed only with a browser identity: an MCP token can never mint or list tokens.

    @r.get("/v1/mcp/tokens")
    async def list_mcp_tokens(owner: str = Identity, app: Anywhere = Depends(anywhere)):
        tokens = sorted(app.vault.mcp_tokens_for(owner), key=lambda t: t["created_at"], reverse=True)
        return {"tokens": [public_token(t) for t in tokens], "scopes": SCOPES}

    @r.post("/v1/mcp/tokens")
    async def create_mcp_token(body: McpTokenIn, owner: str = Identity, app: Anywhere = Depends(anywhere)):
        rate_limit(f"mcp-token:{owner}", 5)
        s = app.settings
        if not s.mcp_enabled:
            raise HTTPException(404, "MCP is turned off on this server")
        acct = await app.account(owner)
        if not acct["activated"]:
            raise ActionError("Activate your account before connecting agents")
        unknown = set(body.scopes) - SCOPES.keys()
        if unknown:
            raise HTTPException(422, f"Unknown permission: {', '.join(sorted(unknown))}")
        if body.expires_days > s.mcp_max_token_days:
            raise HTTPException(422, f"Tokens can last at most {s.mcp_max_token_days} days")
        if len(app.vault.mcp_tokens_for(owner)) >= s.mcp_max_tokens_per_account:
            raise ActionError("You have too many agent tokens. Revoke one first.")
        secret, token = mint_token(app, owner, body.name.strip(), body.scopes, body.expires_days)
        log.info("mcp.token_created", token=token["id"], owner=owner[:12], scopes=token["scopes"])
        return {"token": secret, **token}

    @r.delete("/v1/mcp/tokens/{token_id}")
    async def revoke_mcp_token(token_id: int, owner: str = Identity, app: Anywhere = Depends(anywhere)):
        if not app.vault.delete_mcp_token(owner, token_id):
            raise HTTPException(404, "Token not found")
        log.info("mcp.token_revoked", token=token_id, owner=owner[:12])
        return {"ok": True}

    # OAuth consent and connected apps ---------------------------------------
    # The /connect page in the web app calls these with the browser identity.

    def _oauth(request: Request) -> AnywhereOAuth:
        provider = request.app.state.oauth
        if provider is None:
            raise HTTPException(404, "OAuth sign-in is turned off on this server")
        return provider

    @r.get("/v1/oauth/requests/{request_id}")
    async def oauth_request(request_id: str, request: Request, owner: str = Identity):
        record = _oauth(request).pending(request_id)
        if not record:
            raise HTTPException(404, "This sign-in request has expired. Start again from your app.")
        return {
            "client_name": record["client_name"],
            "redirect_host": urlparse(record["redirect_uri"]).netloc,
            "scopes": record["scopes"],
            "scope_help": SCOPES,
        }

    @r.post("/v1/oauth/requests/{request_id}/decision")
    async def oauth_decision(
        request_id: str,
        body: OAuthDecisionIn,
        request: Request,
        owner: str = Identity,
        app: Anywhere = Depends(anywhere),
    ):
        provider = _oauth(request)
        rate_limit(f"oauth-decision:{owner}", 10)
        if body.approve:
            acct = await app.account(owner)
            if not acct["activated"]:
                raise ActionError("Activate your account before connecting apps")
        return {"redirect": provider.decide(request_id, owner, body.approve, body.scopes)}

    @r.get("/v1/oauth/grants")
    async def list_grants(owner: str = Identity, app: Anywhere = Depends(anywhere)):
        return {
            "grants": [
                {k: g.get(k) for k in ("id", "client_name", "scopes", "created_at", "last_used_at")}
                for g in grants_for(app.vault, owner)
            ]
        }

    @r.delete("/v1/oauth/grants/{grant_id}")
    async def revoke_grant(grant_id: int, owner: str = Identity, app: Anywhere = Depends(anywhere)):
        grant = app.vault.section_get("oauth_grants", str(grant_id))
        if not grant or grant["owner"] != owner:
            raise HTTPException(404, "Connection not found")
        app.vault.drop_grant(grant_id)
        log.info("oauth.grant_revoked", grant=grant_id, owner=owner[:12])
        return {"ok": True}

    # Messaging -------------------------------------------------------------

    @r.post("/v1/messaging/link")
    async def link_phone(body: LinkIn, owner: str = Identity, app: Anywhere = Depends(anywhere)):
        rate_limit(f"link:{owner}", 5)
        try:
            phone = normalize_phone(body.phone)
            assignment = await PhotonClient(app.settings).allowlist(phone)
        except PhotonError as exc:
            raise ActionError(str(exc)) from exc
        await app.store.issue_link_code(owner, phone)
        return {
            "phone": phone,
            "anywhere_number": assignment.assigned_number,
            "deep_link_base": f"{app.settings.spectrum_api_base}/users/{assignment.user_id}/redirect",
        }

    @r.get("/v1/bridge/notifications/{notification_id}/attachment", dependencies=[Depends(require_bridge)])
    async def notification_attachment(notification_id: int, app: Anywhere = Depends(anywhere)):
        """A picture to send after a notification's text (e.g. a render's first frame)."""
        att = app.vault.section_get("notification_attachments", str(notification_id))
        if not att or not app.settings.storage_ready:
            raise HTTPException(404, "No attachment")
        return {"url": app.storage.presign_get(att["key"], 900), "name": att["name"], "mime_type": "image/jpeg"}

    @r.post("/v1/bridge/inbound", dependencies=[Depends(require_bridge)])
    async def inbound(body: InboundIn, request: Request, app: Anywhere = Depends(anywhere)):
        if body.message_id in _seen_inbound:
            return {"reply": None, "duplicate": True}
        _seen_inbound.append(body.message_id)
        handle = body.handle.strip()

        if code := parse_link_code(body.text):
            try:
                await app.store.link_handle(handle, code, "imessage")
                return {
                    "reply": "You're linked. Text me anything you'd like to get done, like “start a Blender desktop”."
                }
            except ReducerRejected as exc:
                return {"reply": f"I couldn't link this number: {_clean_reducer_error(str(exc))}."}

        owner = await app.store.handle_owner(handle)
        if not owner:
            return {
                "reply": "Hi! I'm Anywhere. Link this number from Settings in the web app, then text me the 6-digit code."
            }

        rate_limit(f"imsg:{owner}", 15)
        cid = app.vault.get(0).get(f"imessage:{owner}")
        if not cid:
            cid = new_id()
            await app.store.upsert_conversation(cid, owner, "Messages", "imessage")
            app.vault.update(0, **{f"imessage:{owner}": cid})
        await app.store.append_message(cid, "user", "text", body.text, 0, "imessage")
        ctx = TurnContext(owner, cid, "imessage")
        reply = await _agent_turn(app, request.app.state.agent, ctx, body.text, post=True)
        # Pictures the agent took this turn (send_screenshot) go out right after the reply.
        attachments = [
            {
                "name": f"screenshot-{i + 1}.jpg",
                "mime_type": "image/jpeg",
                "data_base64": base64.b64encode(jpeg).decode(),
            }
            for i, jpeg in enumerate(ctx.attachments)
        ]
        return {"reply": reply, "attachments": attachments}

    return r


async def _agent_turn(app: Anywhere, agent: Agent, ctx: TurnContext, text: str, post: bool = True) -> str:
    # One turn at a time per conversation. Entries are reference-counted and
    # removed when idle, so the table no longer grows with every conversation.
    entry = _turn_locks.setdefault(ctx.conversation_id, [asyncio.Lock(), 0])
    entry[1] += 1
    try:
        async with entry[0]:
            try:
                reply = plain_dashes(await agent.respond(ctx, text))
                kind = "text"
            except ModelUnavailable as exc:
                reply, kind = f"The Nemotron agent isn't configured yet ({exc}).", "error"
            except Exception as exc:
                log.exception("agent.turn_failed", conversation=ctx.conversation_id)
                reply, kind = f"Something went wrong on my side: {exc.__class__.__name__}. Please try again.", "error"
            if post:
                try:
                    await app.store.append_message(ctx.conversation_id, "assistant", kind, reply, 0, ctx.channel)
                except Exception as exc:
                    log.warning("agent.post_failed", error=str(exc))
            return reply
    finally:
        entry[1] -= 1
        if entry[1] == 0:
            _turn_locks.pop(ctx.conversation_id, None)


#: Open watch-link streams by link digest, so turning a link off disconnects them.
_watchers: dict[str, set[WebSocket]] = {}
MAX_WATCHERS = 12


async def _drop_watchers(key: str | None) -> None:
    for ws in list(_watchers.pop(key, set()) if key else ()):
        with contextlib.suppress(Exception):
            await ws.close(code=4403)


async def _no_touch() -> None:
    return None


async def _relay(client: WebSocket, upstream, touch) -> None:
    last_touch = 0.0

    async def down():
        async for msg in upstream:
            if isinstance(msg, bytes):
                await client.send_bytes(msg)
            else:
                await client.send_text(msg)

    async def up():
        nonlocal last_touch
        while True:
            msg = await client.receive()
            if msg["type"] == "websocket.disconnect":
                return
            if (data := msg.get("bytes")) is not None:
                await upstream.send(data)
            elif (text := msg.get("text")) is not None:
                await upstream.send(text)
            if time.monotonic() - last_touch > 60:
                last_touch = time.monotonic()
                # Keep a reference: an unreferenced task can be garbage-collected mid-run.
                t = asyncio.create_task(touch())
                _background.add(t)
                t.add_done_callback(_background.discard)

    downstream, upstream_task = asyncio.create_task(down()), asyncio.create_task(up())
    done, pending = await asyncio.wait([downstream, upstream_task], return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    await asyncio.gather(*pending, return_exceptions=True)
    for t in done:
        # The desktop going away (stop, delete, reboot) ends `down` with ConnectionClosed;
        # that's a normal end of session. Anything else is worth a log line, not a crash.
        if (exc := t.exception()) and not isinstance(exc, (websockets.ConnectionClosed, WebSocketDisconnect)):
            log.warning("vnc.relay_failed", error=f"{exc.__class__.__name__}: {exc}"[:300])
    if downstream in done:
        # The machine side closed: tell the browser now instead of leaving its socket open.
        with contextlib.suppress(Exception):
            await client.close(code=1001)


def _title(text: str) -> str:
    line = text.strip().splitlines()[0]
    return line[:60] + ("…" if len(line) > 60 else "")


__all__ = ["create_app", "budget"]
