"""HTTP API. Commands come in here; state flows back out through SpacetimeDB."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import secrets
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from typing import Literal

import structlog
import websockets
from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

from . import budget
from .agent import Agent, TurnContext
from .auth import Identity, require_bridge
from .brev import BrevCLI
from .config import Settings, get_settings
from .core import ActionError, Anywhere, parse_link_code
from .ids import new_id
from .lifecycle import Status
from .llm import ModelUnavailable
from .photon import PhotonClient, PhotonError, normalize_phone
from .planner import SUPPORTED_APPS, Application, Intent, Preference
from .stdb import ReducerRejected, SpacetimeClient
from .storage import Storage, StorageUnavailable, safe_filename
from .store import Store
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
    return api


def _clean_reducer_error(message: str) -> str:
    return message.split("rejected:", 1)[-1].strip() or "Request rejected"


def anywhere(request: Request) -> Anywhere:
    return request.app.state.anywhere


# ── Rate limiting ───────────────────────────────────────────────────────────

_hits: dict[str, deque[float]] = defaultdict(deque)


def rate_limit(key: str, limit: int, window: float = 60) -> None:
    now = time.monotonic()
    q = _hits[key]
    while q and q[0] < now - window:
        q.popleft()
    if len(q) >= limit:
        raise HTTPException(429, "Slow down a little — try again in a moment")
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


class GoalIn(BaseModel):
    goal: str = Field(min_length=1, max_length=2000)


class UploadIn(BaseModel):
    filename: str = Field(min_length=1, max_length=200)
    content_type: str = Field(default="application/octet-stream", max_length=100)
    size: int = Field(gt=0)


class LinkIn(BaseModel):
    phone: str = Field(min_length=7, max_length=24)


class InboundIn(BaseModel):
    handle: str = Field(min_length=3, max_length=64)
    text: str = Field(max_length=4000)
    message_id: str = Field(min_length=1, max_length=128)


_turn_locks: dict[int, asyncio.Lock] = defaultdict(asyncio.Lock)
_seen_inbound: deque[str] = deque(maxlen=2048)


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

    @r.post("/v1/workloads/{workload_id}/{action}")
    async def workload_action(workload_id: int, action: str, owner: str = Identity, app: Anywhere = Depends(anywhere)):
        if action not in actions:
            raise HTTPException(404, "Unknown action")
        rate_limit(f"action:{owner}", 30)
        await actions[action](app, owner, workload_id)
        return {"ok": True}

    @r.post("/v1/workloads/{workload_id}/agent/run")
    async def agent_run(workload_id: int, body: GoalIn, owner: str = Identity, app: Anywhere = Depends(anywhere)):
        rate_limit(f"agent:{owner}", 10)
        try:
            run_id = await app.operate(owner, workload_id, body.goal)
        except RuntimeError as exc:
            raise ActionError(str(exc)) from exc
        return {"run_id": run_id}

    @r.post("/v1/workloads/{workload_id}/agent/stop")
    async def agent_stop(workload_id: int, owner: str = Identity, app: Anywhere = Depends(anywhere)):
        await app.owned(owner, workload_id)
        await app.supervisor.stop_agent(workload_id)
        await app.store.set_controller(workload_id, "user")
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
                    "reply": "You're linked. Text me anything you'd like to get done — like “start a Blender desktop”."
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
        reply = await _agent_turn(
            app, request.app.state.agent, TurnContext(owner, cid, "imessage"), body.text, post=True
        )
        return {"reply": reply}

    return r


async def _agent_turn(app: Anywhere, agent: Agent, ctx: TurnContext, text: str, post: bool = True) -> str:
    async with _turn_locks[ctx.conversation_id]:
        try:
            reply = await agent.respond(ctx, text)
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
                asyncio.create_task(touch())

    tasks = [asyncio.create_task(down()), asyncio.create_task(up())]
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()


def _title(text: str) -> str:
    line = text.strip().splitlines()[0]
    return line[:60] + ("…" if len(line) > 60 else "")


__all__ = ["create_app", "budget"]
