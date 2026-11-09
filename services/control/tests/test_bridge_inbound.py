"""The bridge's inbound route: quick turns answer inline, long ones ack and text the reply later,
and the bridge secret fails closed when it's too short."""

import asyncio
import time

from fastapi.testclient import TestClient

import anywhere.api as api_module
from anywhere.api import create_app
from anywhere.config import Settings

SECRET = "s" * 32
OWNER = "a1" * 32
PHONE = "+15550100199"


def bridge(tmp_path, monkeypatch, delay: float, secret: str = SECRET):
    monkeypatch.setattr(api_module, "INBOUND_SYNC_SECONDS", 0.2)
    api = create_app(Settings(_env_file=None, data_dir=tmp_path, messaging_bridge_secret=secret))
    texts: list[tuple[str, str]] = []

    async def handle_owner(handle):
        return OWNER

    async def noop(*a, **k):
        return None

    async def enqueue(id, owner, channel, handle, body):
        texts.append((handle, body))

    async def respond(ctx, text):
        await asyncio.sleep(delay)
        return f"echo: {text}"

    def start(c):
        core = c.app.state.anywhere
        core.store.handle_owner = handle_owner
        core.store.upsert_conversation = noop
        core.store.append_message = noop
        core.store.enqueue_notification = enqueue
        c.app.state.agent.respond = respond

    return TestClient(api), start, texts


def post(c, message_id, text="hi", secret=SECRET):
    return c.post(
        "/v1/bridge/inbound",
        json={"handle": PHONE, "text": text, "message_id": message_id},
        headers={"x-bridge-secret": secret},
    )


def test_a_quick_turn_answers_inline_and_is_not_also_queued(tmp_path, monkeypatch):
    api_module._hits.clear()
    c, start, texts = bridge(tmp_path, monkeypatch, delay=0)
    with c:
        start(c)
        body = post(c, "quick-1").json()
        time.sleep(0.3)
    assert body["reply"] == "echo: hi" and not body.get("queued")
    assert texts == []


def test_a_long_turn_acks_then_texts_the_reply_once(tmp_path, monkeypatch):
    api_module._hits.clear()
    c, start, texts = bridge(tmp_path, monkeypatch, delay=0.6)
    with c:
        start(c)
        t0 = time.monotonic()
        body = post(c, "slow-1", "start blender").json()
        assert time.monotonic() - t0 < 0.5
        assert body["queued"] and body["reply"]
        assert post(c, "slow-1", "start blender").json() == {"reply": None, "duplicate": True}
        deadline = time.monotonic() + 3
        while not texts and time.monotonic() < deadline:
            time.sleep(0.05)
        time.sleep(0.2)
    assert texts == [(PHONE, "echo: start blender")]


def test_rate_limited_texts_get_a_429_the_bridge_can_relay(tmp_path, monkeypatch):
    api_module._hits.clear()
    c, start, _ = bridge(tmp_path, monkeypatch, delay=0)
    with c:
        start(c)
        codes = [post(c, f"rl-{i}").status_code for i in range(16)]
        last = post(c, "rl-last")
    assert codes[:15] == [200] * 15 and codes[15] == 429
    assert last.status_code == 429 and "Slow down" in last.json()["detail"]


def test_a_short_bridge_secret_is_refused(tmp_path, monkeypatch):
    c, start, _ = bridge(tmp_path, monkeypatch, delay=0, secret="short")
    with c:
        start(c)
        assert post(c, "m", secret="short").status_code == 503


def test_the_token_cache_is_bounded_and_drops_expired_entries(monkeypatch):
    from anywhere import auth

    auth._cache.clear()
    monkeypatch.setattr(auth, "_CACHE_MAX", 3)
    for i in range(5):
        auth._remember(f"d{i}", "id", now=100.0)
    assert list(auth._cache) == ["d2", "d3", "d4"]
    auth._remember("late", "id", now=100.0 + auth._CACHE_TTL + 1)
    assert list(auth._cache) == ["late"]
    auth._cache.clear()


def test_a_saving_desktop_still_gets_a_stream_ticket(tmp_path):
    from anywhere.auth import current_identity

    api = create_app(Settings(_env_file=None, data_dir=tmp_path))
    api.dependency_overrides[current_identity] = lambda: OWNER
    with TestClient(api) as c:
        status = {"v": "saving"}

        async def owned(owner, workload_id):
            return {"id": workload_id, "owner": owner, "kind": "desktop", "status": status["v"]}

        c.app.state.anywhere.owned = owned
        assert "ticket" in c.post("/v1/desktops/7/session").json()
        status["v"] = "stopping"
        assert c.post("/v1/desktops/7/session").status_code == 409
