"""The MCP server, end to end: real HTTP through the auth layer, the real SDK client, fake backends."""

import base64
import io
import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

import httpx2
import pytest
from fastapi.testclient import TestClient
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from PIL import Image as PILImage

import anywhere.api as api_module
import anywhere.desktop as desktop_module
from anywhere.agent import Agent
from anywhere.auth import current_identity
from anywhere.config import ProvisioningMode, Settings
from anywhere.core import Anywhere
from anywhere.mcp_server import digest, mint_token
from anywhere.stdb import SpacetimeClient, SpacetimeError
from anywhere.storage import Storage
from anywhere.vault import Vault

from .fakes import FakeBrev, FakeStore

ALICE = "a1" * 32
BOB = "b0" * 32
BASE = "http://anywhere.test"


class McpStore(FakeStore):
    """FakeStore plus the account, conversation and planning calls the MCP tools make."""

    def __init__(self):
        super().__init__()
        self.conversations: dict[int, dict] = {}
        self.messages: list[dict] = []
        self.fail_with: Exception | None = None
        self.fail_history = False
        self.runs: list[dict] = []
        self.steps: list[dict] = []

    async def workloads(self):
        if self.fail_with:
            raise self.fail_with
        return await super().workloads()

    async def workload(self, id):
        return next((w for w in await self.workloads() if w["id"] == id), None)

    async def account(self, identity):
        return next((a for a in self.accounts_ if a["identity"] == identity), None)

    async def upsert_conversation(self, id, owner, title, channel):
        self.conversations[id] = {"owner": owner, "title": title, "channel": channel}

    async def append_message(self, conversation_id, role, kind, body, workload_id=0, channel="web"):
        self.messages.append({"cid": conversation_id, "kind": kind, "body": body, "channel": channel})

    async def agent_runs(self, workload_id):
        if self.fail_history:
            raise SpacetimeError("sql failed (400): no such view worker_agent_runs")
        runs = [r for r in self.runs if r["workloadId"] == workload_id]
        return sorted(runs, key=lambda r: r["startedAt"], reverse=True)

    async def agent_steps(self, run_id):
        return [s for s in self.steps if s["runId"] == run_id]

    async def set_controller(self, workload_id, controller):
        self.rows[workload_id]["controller"] = controller

    async def create_workload(self, **w):
        self.add(
            id=w["id"],
            owner=w["owner"],
            conversationId=w["conversation_id"],
            kind=w["kind"],
            title=w["title"],
            summary=w["summary"],
            status="planned",
            statusDetail="",
            planJson=w["plan_json"],
            gpuName=w["gpu_name"],
            hourlyCents=w["hourly_cents"],
            estLowCents=w["est_low_cents"],
            estHighCents=w["est_high_cents"],
        )


def account(identity, *, activated=True, threshold=0):
    return {
        "identity": identity,
        "activated": activated,
        "monthlyCapCents": 5000,
        "approvalThresholdCents": threshold,
        "preference": "balanced",
    }


class Harness:
    def __init__(self, tmp_path, monkeypatch, **overrides):
        settings = Settings(_env_file=None, data_dir=tmp_path, spacetime_worker_token="worker", **overrides)
        self.store = McpStore()
        self.store.accounts_ = [account(ALICE), account(BOB)]
        self.app = Anywhere(
            settings=settings,
            store=self.store,
            public_stdb=SpacetimeClient("http://127.0.0.1:1", "anywhere"),
            brev=FakeBrev(mode=ProvisioningMode.DISABLED),
            storage=Storage(settings),
            vault=Vault(tmp_path / "vault.json"),
        )
        sup = self.app.supervisor
        self.launched: list[int] = []
        self.stopped: list[int] = []
        self.deleted: list[int] = []

        async def _noop():
            return None

        sup.recover = _noop
        sup.start_guard = lambda: None
        sup.launch = lambda w: self.launched.append(w["id"])
        sup.stop = lambda w, reason="": self.stopped.append(w["id"])
        sup.terminate = lambda w, reason="": self.deleted.append(w["id"])
        sup.remote = lambda w: None
        monkeypatch.setattr(api_module, "build", lambda s: (self.app, Agent(self.app)))
        self.api = api_module.create_app(settings)
        self.live = False

    def token(self, owner=ALICE, scopes=("read", "plan", "control"), days=30):
        secret, _ = mint_token(self.app, owner, "test agent", list(scopes), days)
        return secret

    @asynccontextmanager
    async def running(self):
        if self.live:
            yield self
            return
        self.live = True
        try:
            async with self.api.router.lifespan_context(self.api):
                yield self
        finally:
            self.live = False

    @asynccontextmanager
    async def client(self, token):
        async with self.running(), self._client(token) as c:
            yield c

    @asynccontextmanager
    async def _client(self, token):
        http = httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=self.api),
            base_url=BASE,
            headers={"Authorization": f"Bearer {token}"},
        )
        async with http, Client(streamable_http_client(f"{BASE}/mcp", http_client=http)) as c:
            yield c

    async def raw(self, headers=None):
        """A bare JSON-RPC POST, for checks that happen before the SDK sees the request."""
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=self.api), base_url=BASE) as http:
            return await http.post(
                "/mcp",
                json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
                headers={"Accept": "application/json, text/event-stream", **(headers or {})},
            )


@pytest.fixture
def h(tmp_path, monkeypatch):
    return Harness(tmp_path, monkeypatch)


def text(result) -> str:
    return " ".join(getattr(c, "text", "") for c in result.content)


def data(result) -> dict:
    assert not result.is_error, text(result)
    return result.structured_content or json.loads(text(result))


# ── Authentication and transport ────────────────────────────────────────────


async def test_requests_without_a_valid_token_are_refused(h):
    async with h.running():
        for headers in (
            {},
            {"Authorization": "Bearer "},
            {"Authorization": "Basic abc"},
            {"Authorization": "Bearer awmcp_not-a-real-token-at-all"},
            {"Authorization": "Bearer " + "x" * 40},
            {"Authorization": "Bearer awmcp_" + "y" * 500},
        ):
            res = await h.raw(headers)
            assert res.status_code == 401, headers
            assert "Bearer" in res.headers["www-authenticate"]


async def test_expired_and_revoked_tokens_stop_working(h):
    expired = h.token()
    h.app.vault.update_mcp_token(digest(expired), expires_at=(datetime.now(UTC) - timedelta(seconds=1)).isoformat())
    revoked = h.token()
    async with h.running():
        assert (await h.raw({"Authorization": f"Bearer {expired}"})).status_code == 401
        assert (await h.raw({"Authorization": f"Bearer {revoked}"})).status_code == 200
        record = h.app.vault.mcp_token(digest(revoked))
        assert h.app.vault.delete_mcp_token(ALICE, record["id"])
        assert (await h.raw({"Authorization": f"Bearer {revoked}"})).status_code == 401


async def test_foreign_origins_are_refused(h):
    token = h.token()
    async with h.running():
        evil = await h.raw({"Authorization": f"Bearer {token}", "Origin": "https://evil.example"})
        assert evil.status_code == 403
        ours = await h.raw({"Authorization": f"Bearer {token}", "Origin": h.app.settings.public_web_origin})
        assert ours.status_code == 200


async def test_mcp_can_be_switched_off(tmp_path, monkeypatch):
    h = Harness(tmp_path, monkeypatch, mcp_enabled=False)
    token = h.token()
    async with h.running():
        assert (await h.raw({"Authorization": f"Bearer {token}"})).status_code == 404


async def test_oversized_requests_are_refused(h):
    token = h.token()
    async with h.running(), httpx2.AsyncClient(transport=httpx2.ASGITransport(app=h.api), base_url=BASE) as http:
        res = await http.post(
            "/mcp",
            content=b'{"pad":"' + b"x" * (300 * 1024) + b'"}',
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            },
        )
    assert res.status_code == 413


async def test_secrets_are_never_stored(h, tmp_path):
    token = h.token()
    stored = (tmp_path / "vault.json").read_text()
    assert token not in stored
    assert digest(token) in stored


# ── Tools ───────────────────────────────────────────────────────────────────


async def test_lists_tools_with_honest_annotations(h):
    async with h.running(), h.client(h.token()) as c:
        tools = {t.name: t for t in (await c.list_tools()).tools}
    assert set(tools) == {
        "get_account",
        "get_catalog",
        "list_workloads",
        "get_workload",
        "get_desktop_screenshot",
        "propose_workload",
        "cancel_plan",
        "approve_workload",
        "stop_workload",
        "resume_desktop",
        "save_project",
        "delete_workload",
        "operate_desktop",
        "stop_desktop_agent",
    }
    for name in ("get_account", "get_catalog", "list_workloads", "get_workload", "get_desktop_screenshot"):
        assert tools[name].annotations.read_only_hint
    assert tools["delete_workload"].annotations.destructive_hint
    assert "money" in tools["approve_workload"].description


async def test_users_only_ever_see_their_own_machines(h):
    h.store.add(id=11, owner=ALICE, status="running", conversationId=1)
    h.store.add(id=22, owner=BOB, status="running", conversationId=2)
    async with h.running(), h.client(h.token(ALICE)) as c:
        ids = [w["workload_id"] for w in data(await c.call_tool("list_workloads", {}))["workloads"]]
        assert ids == [11]
        peek = await c.call_tool("get_workload", {"workload_id": 22})
        assert peek.is_error and "not found" in text(peek)
        stop = await c.call_tool("stop_workload", {"workload_id": 22})
        assert stop.is_error and "not found" in text(stop)
    assert h.stopped == []


async def test_proposals_wait_for_a_human_without_the_spend_permission(h):
    # Even an account that auto-approves everything must not let a plan-only token spend.
    h.store.accounts_ = [account(ALICE, threshold=5000)]
    async with h.running(), h.client(h.token(scopes=("read", "plan"))) as c:
        result = data(
            await c.call_tool(
                "propose_workload",
                {"request": {"kind": "desktop", "summary": "A Blender desktop", "application": "blender"}},
            )
        )
        assert result["ok"] and not result["auto_approved"]
        assert result["workload"]["needs_approval"]
        assert "web app" in result["next_step"]
        wid = result["workload_id"]
        approve = await c.call_tool("approve_workload", {"workload_id": wid})
        assert approve.is_error and "'spend' permission" in text(approve)
    assert h.launched == []
    # The plan lands in a dedicated, clearly labelled conversation.
    (convo,) = h.store.conversations.values()
    assert convo == {"owner": ALICE, "title": "Agent: test agent", "channel": "mcp"}


async def test_spend_permission_approves_and_leaves_an_audit_trail(h):
    async with h.running(), h.client(h.token(scopes=("read", "plan", "spend"))) as c:
        result = data(
            await c.call_tool("propose_workload", {"request": {"kind": "desktop", "summary": "VS Code to hack on"}})
        )
        assert not result["auto_approved"] and "approve_workload" in result["next_step"]
        approved = data(await c.call_tool("approve_workload", {"workload_id": result["workload_id"]}))
        assert approved["ok"]
        again = await c.call_tool("approve_workload", {"workload_id": result["workload_id"]})
        assert again.is_error and "already" in text(again)
    assert h.launched == [result["workload_id"]]
    assert any("approved the plan" in m["body"] and m["channel"] == "mcp" for m in h.store.messages)


async def test_status_includes_the_latest_agent_run(h):
    h.store.add(id=11, owner=ALICE, status="running", conversationId=1)
    h.store.runs = [
        {"id": 1, "workloadId": 11, "goal": "Old goal", "status": "succeeded", "result": "", "startedAt": 1},
        {"id": 2, "workloadId": 11, "goal": "Make a low-poly tree", "status": "running", "result": "", "startedAt": 2},
    ]
    h.store.steps = [
        {"runId": 2, "seq": i, "kind": "act", "summary": f"step {i}", "screenshotKey": "k" if i % 2 else ""}
        for i in range(20)
    ]
    async with h.running(), h.client(h.token()) as c:
        agent = data(await c.call_tool("get_workload", {"workload_id": 11}))["agent"]
        assert agent["run_id"] == 2 and agent["goal"] == "Make a low-poly tree" and agent["total_runs"] == 2
        assert [s["seq"] for s in agent["steps"]] == list(range(5, 20))
        assert agent["steps"][0]["has_screenshot"]
        # A database without the history views still answers, just without history.
        h.store.fail_history = True
        assert data(await c.call_tool("get_workload", {"workload_id": 11}))["agent"] is None


def _png(width=1920, height=1080) -> bytes:
    buf = io.BytesIO()
    PILImage.new("RGB", (width, height), (40, 90, 160)).save(buf, format="PNG")
    return buf.getvalue()


async def _no_tunnel(self, workload_id, remote):
    return 0


async def test_screenshots_of_running_desktops(h, monkeypatch):
    h.store.add(id=11, owner=ALICE, status="running", conversationId=1)
    h.store.add(id=12, owner=ALICE, status="stopped", conversationId=1)
    calls = []

    class Screen:
        async def screenshot(self):
            return _png()

    @asynccontextmanager
    async def connect(remote, token, port=None):
        calls.append(token)
        yield Screen()

    monkeypatch.setattr(desktop_module, "connect_screen", connect)
    monkeypatch.setattr(desktop_module.TunnelPool, "port_for", _no_tunnel)
    async with h.running(), h.client(h.token(scopes=("read",))) as c:
        shot = await c.call_tool("get_desktop_screenshot", {"workload_id": 11})
        assert not shot.is_error, text(shot)
        (image,) = shot.content
        assert image.mime_type == "image/jpeg"
        assert PILImage.open(io.BytesIO(base64.b64decode(image.data))).width == 1280
        again = await c.call_tool("get_desktop_screenshot", {"workload_id": 11})
        assert not again.is_error  # served from the short frame cache
        stopped = await c.call_tool("get_desktop_screenshot", {"workload_id": 12})
        assert stopped.is_error and "running desktop" in text(stopped)
    assert len(calls) == 1


async def test_unreachable_desktops_fail_politely(h, monkeypatch):
    h.store.add(id=11, owner=ALICE, status="running", conversationId=1)

    @asynccontextmanager
    async def connect(remote, token, port=None):
        raise OSError("ssh: connect to host 10.0.0.7 port 22: Connection refused")
        yield

    monkeypatch.setattr(desktop_module, "connect_screen", connect)
    monkeypatch.setattr(desktop_module.TunnelPool, "port_for", _no_tunnel)
    async with h.running(), h.client(h.token()) as c:
        shot = await c.call_tool("get_desktop_screenshot", {"workload_id": 11})
    assert shot.is_error and "Couldn't reach the desktop" in text(shot) and "10.0.0.7" not in text(shot)


async def test_deleting_needs_explicit_confirmation(h):
    h.store.add(id=11, owner=ALICE, status="stopped", conversationId=1)
    async with h.running(), h.client(h.token()) as c:
        missing = await c.call_tool("delete_workload", {"workload_id": 11})
        assert missing.is_error
        refused = await c.call_tool("delete_workload", {"workload_id": 11, "confirm": False})
        assert refused.is_error and "confirm=true" in text(refused)
        assert data(await c.call_tool("delete_workload", {"workload_id": 11, "confirm": True}))["ok"]
    assert h.deleted == [11]


async def test_bad_arguments_are_rejected_before_anything_runs(h):
    async with h.running(), h.client(h.token()) as c:
        for args in ({"workload_id": 0}, {"workload_id": 2**60}, {"workload_id": "eleven"}, {}):
            assert (await c.call_tool("get_workload", args)).is_error, args
        for request in (
            {"kind": "render", "summary": "Render my film"},
            {"kind": "desktop", "summary": "x"},
            {"kind": "fine_tune", "summary": "Tune it", "epochs": 500},
            {"kind": "desktop", "summary": "Blender", "max_budget_usd": -5},
        ):
            assert (await c.call_tool("propose_workload", {"request": request})).is_error, request
        goal = await c.call_tool("operate_desktop", {"workload_id": 1, "goal": "x" * 5000})
        assert goal.is_error
    assert h.store.rows == {}


async def test_backend_failures_become_safe_messages(h):
    async with h.running(), h.client(h.token()) as c:
        h.store.fail_with = SpacetimeError("sql failed (500): internal table dump 0xdeadbeef")
        down = await c.call_tool("list_workloads", {})
        assert down.is_error and "temporarily unavailable" in text(down)
        assert "deadbeef" not in text(down)
        h.store.fail_with = KeyError("planJson")
        crash = await c.call_tool("list_workloads", {})
        assert crash.is_error and "has been logged" in text(crash)
        assert "planJson" not in text(crash)


async def test_tools_refuse_while_the_database_is_unconfigured(tmp_path, monkeypatch):
    h = Harness(tmp_path, monkeypatch)
    h.app.settings.spacetime_worker_token = None
    async with h.running(), h.client(h.token()) as c:
        result = await c.call_tool("get_account", {})
    assert result.is_error and "isn't connected" in text(result)


async def test_deactivated_accounts_pause_their_tokens(h):
    h.store.accounts_ = [account(ALICE, activated=False)]
    async with h.running(), h.client(h.token()) as c:
        result = await c.call_tool("list_workloads", {})
    assert result.is_error and "isn't active" in text(result)


async def test_reports_account_limits_and_token_permissions(h):
    async with h.running(), h.client(h.token(scopes=("read",))) as c:
        acct = data(await c.call_tool("get_account", {}))
        assert acct["monthly_cap"] == "$50.00" and acct["token_permissions"] == ["read"]
        assert acct["provisioning_mode"] == "disabled"
        blocked = await c.call_tool("propose_workload", {"request": {"kind": "desktop", "summary": "A desktop"}})
        assert blocked.is_error and "'plan' permission" in text(blocked)


async def test_tool_calls_are_rate_limited(h):
    async with h.running(), h.client(h.token(scopes=("read", "spend"))) as c:
        results = [await c.call_tool("approve_workload", {"workload_id": 1}) for _ in range(7)]
    assert "Too many requests" in text(results[-1])


# ── Token management (browser-authenticated) ────────────────────────────────


def browser(h, owner=ALICE):
    h.api.dependency_overrides[current_identity] = lambda: owner
    return TestClient(h.api)


def test_token_lifecycle_through_the_web_api(h):
    with browser(h) as c:
        made = c.post("/v1/mcp/tokens", json={"name": "Claude Code", "scopes": ["read", "plan"]})
        assert made.status_code == 200, made.text
        body = made.json()
        assert body["token"].startswith("awmcp_") and body["scopes"] == ["plan", "read"]
        listed = c.get("/v1/mcp/tokens").json()
        assert [t["name"] for t in listed["tokens"]] == ["Claude Code"]
        assert body["token"] not in json.dumps(listed) and "spend" in listed["scopes"]
        assert c.delete(f"/v1/mcp/tokens/{body['id']}").status_code == 200
        assert c.get("/v1/mcp/tokens").json()["tokens"] == []
        assert c.delete(f"/v1/mcp/tokens/{body['id']}").status_code == 404


def test_token_creation_is_validated(h):
    h.store.accounts_ = [account(ALICE), account(BOB, activated=False)]
    with browser(h) as c:
        assert c.post("/v1/mcp/tokens", json={"name": "x", "scopes": ["admin"]}).status_code == 422
        assert c.post("/v1/mcp/tokens", json={"name": "x", "scopes": []}).status_code == 422
        assert c.post("/v1/mcp/tokens", json={"name": "x", "expires_days": 9999}).status_code == 422
        assert c.post("/v1/mcp/tokens", json={"name": ""}).status_code == 422
    with browser(h, BOB) as c:
        assert c.post("/v1/mcp/tokens", json={"name": "x"}).status_code == 409


def test_tokens_per_account_are_capped(tmp_path, monkeypatch):
    h = Harness(tmp_path, monkeypatch, mcp_max_tokens_per_account=2)
    for _ in range(2):
        h.token()
    with browser(h) as c:
        assert c.post("/v1/mcp/tokens", json={"name": "third"}).status_code == 409


def test_users_cannot_revoke_each_others_tokens(h):
    h.token(BOB)
    bob_id = h.app.vault.mcp_tokens_for(BOB)[0]["id"]
    with browser(h, ALICE) as c:
        assert c.delete(f"/v1/mcp/tokens/{bob_id}").status_code == 404
    assert h.app.vault.mcp_tokens_for(BOB)


def test_token_endpoints_require_a_browser_identity(tmp_path):
    with TestClient(api_module.create_app(Settings(_env_file=None, data_dir=tmp_path))) as c:
        assert c.get("/v1/mcp/tokens").status_code == 401
        assert c.post("/v1/mcp/tokens", json={"name": "x"}).status_code == 401
        # An MCP token is not a browser identity, so it can never mint more tokens.
        mcp_token = {"Authorization": "Bearer awmcp_" + "z" * 43}
        assert c.post("/v1/mcp/tokens", json={"name": "x"}, headers=mcp_token).status_code == 401
