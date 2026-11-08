"""`anywhere doctor` and /health readiness with nothing configured: no crashes, clear output."""

from fastapi.testclient import TestClient

from anywhere.api import create_app
from anywhere.config import ProvisioningMode, Settings
from anywhere.doctor import Check, Readiness, render, run_all


async def test_doctor_reports_not_configured_without_network(tmp_path):
    s = Settings(_env_file=None, data_dir=tmp_path, brev_binary="definitely-not-installed-brev")
    checks = await run_all(s, live=True)
    by_key = {c.key: c for c in checks if c.key != "policy"}
    assert set(by_key) == {"spacetime", "nemotron", "brev", "storage", "photon"}
    assert all(c.status == "not configured" for c in by_key.values())
    out = render(checks)
    assert out.startswith("Anywhere doctor")
    assert "[  --] SpacetimeDB worker" in out and "Provisioning mode" in out and "Budget limits" in out
    assert out.rstrip().endswith("0 ok, 0 warning(s), 0 failed, 5 not configured")


async def test_brev_key_without_binary_is_a_failure(tmp_path):
    s = Settings(_env_file=None, data_dir=tmp_path, brev_api_key="bak-x", brev_binary="definitely-not-installed-brev")
    checks = {c.key: c for c in await run_all(s, live=False)}
    assert checks["brev"].failed and "not found" in checks["brev"].detail


def test_live_mode_is_flagged(tmp_path):
    s = Settings(_env_file=None, data_dir=tmp_path, provisioning_mode=ProvisioningMode.LIVE)
    assert "real, billed" in render([Check("policy", "Provisioning mode", "warn", "live: real, billed")])
    r = Readiness(s)
    assert r.integrations() == dict.fromkeys(("spacetime", "nemotron", "brev", "storage", "photon"), False)


def test_failed_probe_turns_integration_off(tmp_path):
    s = Settings(_env_file=None, data_dir=tmp_path, spectrum_project_id="p", spectrum_project_secret="s")
    r = Readiness(s)
    assert r.integrations()["photon"] is True  # configured, not yet probed
    r.checks["photon"] = Check("photon", "Photon", "fail", "401")
    assert r.integrations()["photon"] is False
    assert r.details()["photon"] == {"configured": True, "status": "fail", "detail": "401"}


def test_health_includes_per_integration_checks(tmp_path):
    with TestClient(create_app(Settings(_env_file=None, data_dir=tmp_path))) as c:
        body = c.get("/health").json()
    assert set(body["checks"]) == set(body["integrations"])
    assert all(v["configured"] is False for v in body["checks"].values())
