"""Integration adapters checked against the real interfaces they wrap."""

import json
import os
import stat
import subprocess

import httpx
import pytest
import respx
from botocore.exceptions import ClientError

from anywhere import supervisor as sup_mod
from anywhere.brev import BrevCLI, BrevError, parse_ls
from anywhere.config import ProvisioningMode, Settings
from anywhere.photon import PhotonClient
from anywhere.remote import quote_path
from anywhere.storage import Storage, StorageUnavailable, client_config, client_region

# ── Brev ────────────────────────────────────────────────────────────────────


def test_parse_ls_matches_cli_json_shape():
    # brev-cli v0.6.337 prints {"workspaces": null} for an empty org.
    assert parse_ls('{"workspaces": null}') == []
    rows = parse_ls(json.dumps({"workspaces": [{"name": "anywhere-1", "status": "RUNNING", "shell_status": "READY"}]}))
    assert rows[0]["name"] == "anywhere-1"
    # Unauthenticated: an interactive prompt and "EOF" on stdout with exit code 0.
    with pytest.raises(BrevError, match="BREV_API_KEY"):
        parse_ls("You are currently logged out, would you like to log in? [Y/n]: EOF")


@pytest.fixture
def fake_brev(tmp_path):
    """A stand-in `brev` binary that records its argv, env and stdin."""
    log = tmp_path / "calls.jsonl"
    script = tmp_path / "brev"
    script.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, sys\n"
        f"open({str(log)!r}, 'a').write(json.dumps({{'argv': sys.argv[1:], 'key': os.environ.get('BREV_API_KEY'),"
        " 'stdin_tty': sys.stdin.isatty(), 'stdin': sys.stdin.read()}) + '\\n')\n"
        "cmd = sys.argv[1]\n"
        "if cmd == 'ls': print(json.dumps({'workspaces': [{'name': 'anywhere-a', 'status': 'RUNNING', 'shell_status': 'READY'}]}))\n"
        "elif cmd == 'search': print(json.dumps([{'type': 'g2-standard-4:nvidia-l4:1', 'price_per_hour': 0.85}]))\n"
        "elif cmd == 'create' and '--dry-run' in sys.argv: print(sys.argv[sys.argv.index('--type') + 1])\n"
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)

    def calls():
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    return str(script), calls


async def test_create_uses_verified_flags_and_env_auth(fake_brev, tmp_path):
    binary, calls = fake_brev
    boot = tmp_path / "boot.sh"
    boot.write_text("true")
    cli = BrevCLI(binary, "bak-test", ProvisioningMode.LIVE)
    await cli.create("anywhere-1f", "g2-standard-4:nvidia-l4:1", boot)
    (call,) = calls()
    assert call["argv"] == [
        "create", "anywhere-1f", "--type", "g2-standard-4:nvidia-l4:1", "--mode", "vm", "--jupyter=false",
        "--startup-script", f"@{boot}", "--detached",
    ]  # fmt: skip
    assert call["key"] == "bak-test" and call["stdin"] == ""


async def test_dry_run_validates_auth_and_type(fake_brev, tmp_path):
    binary, calls = fake_brev
    boot = tmp_path / "boot.sh"
    boot.write_text("true")
    cli = BrevCLI(binary, "bak-test", ProvisioningMode.DRY_RUN)
    result = await cli.create("anywhere-1f", "g2-standard-4:nvidia-l4:1", boot)
    assert result.dry_run
    assert [c["argv"][0] for c in calls()] == ["ls", "search", "create"]
    with pytest.raises(BrevError, match="does not currently offer"):
        await cli.create("anywhere-2f", "made-up-type", boot)


async def test_start_is_detached_and_list_parses(fake_brev):
    binary, calls = fake_brev
    cli = BrevCLI(binary, "bak-test", ProvisioningMode.LIVE)
    await cli.start("anywhere-a")
    assert calls()[-1]["argv"] == ["start", "anywhere-a", "--detached"]
    (inst,) = await cli.list()
    assert inst.name == "anywhere-a" and inst.ready


async def test_missing_binary_is_a_brev_error():
    with pytest.raises(BrevError, match="not found"):
        await BrevCLI("/nonexistent/brev", "bak-x", ProvisioningMode.LIVE).list()


# ── SSH paths ───────────────────────────────────────────────────────────────


def test_quote_path_expands_home_but_quotes_the_rest(tmp_path):
    assert quote_path("~/workspace/anywhere/job/run.sh") == '"$HOME"/workspace/anywhere/job/run.sh'
    assert quote_path("/tmp/a b") == "'/tmp/a b'"
    out = subprocess.run(
        ["bash", "-c", f"echo {quote_path('~/x y;rm')}"],
        capture_output=True,
        text=True,
        env={**os.environ, "HOME": "/h"},
    ).stdout.strip()
    assert out == "/h/x y;rm"


# ── Object storage ──────────────────────────────────────────────────────────


def test_storage_addressing_and_region():
    assert client_region(None, "auto") == "us-east-1"
    assert client_region("https://acct.r2.cloudflarestorage.com", "auto") == "auto"
    r2 = client_config("https://acct.r2.cloudflarestorage.com")
    assert r2.s3["addressing_style"] == "path" and r2.request_checksum_calculation == "when_required"
    assert client_config(None).s3 is None


def test_presigned_urls_are_sigv4_path_style_for_r2():
    s = Settings(
        _env_file=None,
        s3_endpoint_url="https://acct.r2.cloudflarestorage.com",
        s3_bucket="anywhere",
        s3_access_key_id="AK",
        s3_secret_access_key="SK",
    )
    url = Storage(s).presign_put("users/x/uploads/1/data.jsonl", "application/json")
    assert url.startswith("https://acct.r2.cloudflarestorage.com/anywhere/users/x/uploads/1/data.jsonl?")
    assert "X-Amz-Algorithm=AWS4-HMAC-SHA256" in url and "%2Fauto%2Fs3%2F" in url
    assert "x-amz-checksum" not in url.lower()


async def test_head_distinguishes_missing_from_forbidden():
    s = Settings(_env_file=None, s3_bucket="b", s3_access_key_id="AK", s3_secret_access_key="SK")
    storage = Storage(s)

    def raiser(status, code):
        def head_object(**_):
            raise ClientError({"Error": {"Code": code}, "ResponseMetadata": {"HTTPStatusCode": status}}, "HeadObject")

        return head_object

    storage._client.head_object = raiser(404, "404")
    assert await storage.head("k") is None
    storage._client.head_object = raiser(403, "403")
    with pytest.raises(StorageUnavailable):
        await storage.head("k")


# ── Photon ──────────────────────────────────────────────────────────────────

PROJECT = "11111111-1111-4111-8111-111111111111"


@respx.mock
async def test_photon_existing_user_lookup_reads_data_users():
    s = Settings(_env_file=None, spectrum_project_id=PROJECT, spectrum_project_secret="sec")
    base = f"https://spectrum.photon.codes/projects/{PROJECT}/users/"
    respx.post(base).mock(return_value=httpx.Response(409, json={"succeed": False, "message": "dup"}))
    respx.get(base).mock(
        return_value=httpx.Response(
            200,
            json={
                "succeed": True,
                "data": {
                    "users": [{"id": "u1", "phoneNumber": "+15550100199", "assignedPhoneNumber": "+15550100000"}],
                    "total": 1,
                },
            },
        )
    )
    a = await PhotonClient(s).allowlist("+15550100199")
    assert (a.user_id, a.assigned_number) == ("u1", "+15550100000")


@respx.mock
async def test_photon_project_check_uses_basic_auth():
    s = Settings(_env_file=None, spectrum_project_id=PROJECT, spectrum_project_secret="sec")
    route = respx.get(f"https://spectrum.photon.codes/projects/{PROJECT}/").mock(
        return_value=httpx.Response(200, json={"succeed": True, "data": {"name": "Anywhere", "slug": "anywhere"}})
    )
    assert (await PhotonClient(s).get_project())["name"] == "Anywhere"
    assert route.calls[0].request.headers["authorization"].startswith("Basic ")


# ── Training telemetry protocol ─────────────────────────────────────────────


def test_poll_protocol_in_a_real_shell(tmp_path, monkeypatch):
    monkeypatch.setattr(sup_mod, "JOB_DIR", str(tmp_path))
    (tmp_path / "run.log").write_text("::step:: Checking the GPU\nhéllo\n")
    (tmp_path / "metrics.jsonl").write_text(
        json.dumps({"step": 5, "loss": 1.5, "max_steps": 10}) + '\n{"step": 10, "lo'
    )
    (tmp_path / "pid").write_text(str(os.getpid()))

    def poll(offset, lines):
        out = subprocess.run(["bash", "-c", sup_mod.poll_command(offset, lines)], capture_output=True, text=True)
        return sup_mod.parse_poll(out.stdout, offset)

    p = poll(0, 0)
    assert p.log.startswith("::step:: Checking the GPU") and p.offset == len((tmp_path / "run.log").read_bytes())
    assert len(p.metric_rows) == 1  # the half-written line is held back
    assert sup_mod.metric_points(p.metric_rows) == [
        {"name": "loss", "step": 5, "value": 1.5},
        {"name": "progress", "step": 5, "value": 0.5},
    ]
    assert p.status == "" and p.alive == "yes"

    with (tmp_path / "metrics.jsonl").open("a") as f:
        f.write('ss": 1.2}\n')
    (tmp_path / "status").write_text("succeeded\n")
    p2 = poll(p.offset, 1)
    assert p2.log == "" and p2.status == "succeeded"
    assert sup_mod.metric_points(p2.metric_rows) == [{"name": "loss", "step": 10, "value": 1.2}]

    (tmp_path / "pid").write_text("999999")
    assert poll(p.offset, 2).alive == "no"


def test_poll_protocol_cuts_at_line_boundaries_and_flags_missing_dirs(tmp_path, monkeypatch):
    monkeypatch.setattr(sup_mod, "JOB_DIR", str(tmp_path))

    def poll(offset, chunk=12000):
        cmd = sup_mod.poll_command(offset, 0, chunk=chunk)
        out = subprocess.run(["bash", "-c", cmd], capture_output=True, text=True)
        return sup_mod.parse_poll(out.stdout, offset, chunk=chunk)

    # A partly written last line (and a multibyte char split by the chunk) is held back.
    (tmp_path / "run.log").write_bytes("::step:: One\nhé".encode())
    p = poll(0)
    assert p.log == "::step:: One\n" and p.offset == len(b"::step:: One\n")
    long_text = "::step:: Two ünïcode line\n" * 3
    (tmp_path / "run.log").write_bytes(long_text.encode())
    p = poll(0, chunk=40)  # cuts inside the second line
    assert p.log == "::step:: Two ünïcode line\n" and "\ufffd" not in p.log
    assert poll(p.offset, chunk=40).log == "::step:: Two ünïcode line\n"
    # Once the job has a status, the unterminated tail is flushed.
    (tmp_path / "run.log").write_bytes(b"done")
    (tmp_path / "status").write_text("failed: boom\n")
    assert poll(0).log == "done"

    monkeypatch.setattr(sup_mod, "JOB_DIR", str(tmp_path / "gone"))
    gone = poll(0)
    assert gone.found is False
