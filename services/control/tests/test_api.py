import asyncio

from fastapi.testclient import TestClient

from anywhere.api import create_app, issue_ticket, read_ticket
from anywhere.config import Settings
from anywhere.core import parse_link_code
from anywhere.photon import PhotonError, normalize_phone


def client(tmp_path):
    return TestClient(create_app(Settings(_env_file=None, data_dir=tmp_path)))


def test_health_reports_integrations_without_secrets(tmp_path):
    with client(tmp_path) as c:
        body = c.get("/health").json()
    assert body["ok"] and body["mode"] == "disabled"
    assert set(body["integrations"]) == {"spacetime", "nemotron", "brev", "storage", "photon"}
    assert not any(body["integrations"].values())


def test_catalog_is_public_and_priced(tmp_path):
    with client(tmp_path) as c:
        offers = c.get("/v1/catalog").json()["offers"]
    assert offers and all(o["price_per_hour"] > 0 and o["price_source"] in ("snapshot", "live") for o in offers)


def test_commands_require_authentication(tmp_path):
    with client(tmp_path) as c:
        assert c.post("/v1/chat", json={"text": "hi"}).status_code == 401
        assert c.post("/v1/workloads/1/approve").status_code == 401
        assert (
            c.post("/v1/bridge/inbound", json={"handle": "+15550100", "text": "hi", "message_id": "m"}).status_code
            == 401
        )
        assert c.get("/v1/bridge/notifications/1/attachment").status_code == 401


def test_vnc_tickets_are_signed_scoped_and_short_lived():
    key = b"k" * 32
    t = issue_ticket(key, 42, "owner", ttl=60)
    assert read_ticket(key, t)["w"] == 42
    assert read_ticket(b"x" * 32, t) is None
    tampered = t.replace(t[3], "A" if t[3] != "A" else "B", 1)
    assert read_ticket(key, tampered) is None
    assert read_ticket(key, issue_ticket(key, 42, "owner", ttl=-1)) is None


def test_link_codes_and_phone_numbers():
    assert parse_link_code("LINK 482913") == "482913"
    assert parse_link_code(" 482913 ") == "482913"
    assert parse_link_code("start a desktop") is None
    assert normalize_phone("(555) 010-0199") == "+15550100199"
    try:
        normalize_phone("12")
        raise AssertionError
    except PhotonError:
        pass


def test_empty_env_values_count_as_unset(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "")
    monkeypatch.setenv("BREV_API_KEY", "")
    s = Settings(_env_file=None)
    assert not s.nemotron_ready and not s.brev_ready


def test_idle_rate_limit_keys_are_swept(monkeypatch):
    from anywhere import api

    api._hits.clear()
    clock = [1000.0]
    monkeypatch.setattr(api.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(api, "_last_sweep", 0.0)
    api.rate_limit("ip:1", 5)
    clock[0] += 120
    api.rate_limit("ip:2", 5)
    assert "ip:1" not in api._hits and "ip:2" in api._hits


class _Upstream:
    """A VNC upstream that sends one frame and then drops, as when a desktop stops."""

    def __init__(self):
        self.sent = []

    def __aiter__(self):
        return self._frames()

    async def _frames(self):
        yield b"frame"
        import websockets

        raise websockets.ConnectionClosedError(None, None)

    async def send(self, data):
        self.sent.append(data)


class _Browser:
    def __init__(self):
        self.received, self.closed = [], None

    async def send_bytes(self, data):
        self.received.append(data)

    async def send_text(self, data):
        self.received.append(data)

    async def receive(self):
        await asyncio.sleep(3600)

    async def close(self, code=1000):
        self.closed = code


async def test_vnc_relay_closes_the_browser_when_the_desktop_goes_away(caplog):
    from anywhere.api import _relay

    browser = _Browser()

    async def touch():
        return None

    await asyncio.wait_for(_relay(browser, _Upstream(), touch), 5)
    assert browser.received == [b"frame"]
    assert browser.closed == 1001
