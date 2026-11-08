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
