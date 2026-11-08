import asyncio

import pytest

from anywhere.brev import instance_name
from anywhere.config import ProvisioningMode, Settings
from anywhere.storage import Storage
from anywhere.supervisor import Supervisor
from anywhere.vault import Vault

from .fakes import FakeBrev, FakeRemote, FakeStore, ago


def make(tmp_path, brev: FakeBrev, **settings):
    s = Settings(_env_file=None, provisioning_mode=brev.mode, brev_api_key="bak-test", data_dir=tmp_path, **settings)
    store = FakeStore()
    notes: list[tuple[str, str]] = []

    async def notify(w, kind, body):
        notes.append((kind, body))

    sup = Supervisor(s, store, brev, Storage(s), Vault(tmp_path / "vault.json"), notify, remote_factory=FakeRemote)
    return sup, store, notes


async def drain(sup: Supervisor):
    await asyncio.gather(*[t for t in sup._tasks.values()], return_exceptions=True)


async def test_failed_provisioning_deletes_the_instance(tmp_path):
    brev = FakeBrev(fail_wait=True)
    sup, store, notes = make(tmp_path, brev)
    w = store.add()
    sup.launch(w)
    await drain(sup)
    assert store.rows[1]["status"] == "failed"
    assert ("delete", instance_name(1)) in brev.calls
    assert brev.instances == {}
    assert any(kind == "error" for kind, _ in notes)


async def test_dry_run_creates_nothing_and_cancels(tmp_path):
    brev = FakeBrev(mode=ProvisioningMode.DRY_RUN)
    sup, store, _ = make(tmp_path, brev)
    sup.launch(store.add())
    await drain(sup)
    assert store.rows[1]["status"] == "cancelled"
    assert brev.instances == {}
    assert not any(c[0] == "delete" for c in brev.calls)


async def test_disabled_provisioning_is_reported_not_attempted(tmp_path):
    brev = FakeBrev(mode=ProvisioningMode.DISABLED)
    sup, store, notes = make(tmp_path, brev)
    sup.launch(store.add())
    await drain(sup)
    assert store.rows[1]["status"] == "cancelled"
    assert "disabled" in store.rows[1]["statusDetail"].lower()


async def test_guard_saves_and_stops_an_idle_desktop(tmp_path):
    brev = FakeBrev()
    sup, store, _ = make(tmp_path, brev, desktop_idle_minutes=20)
    w = store.add(status="running", lastActiveAt=ago(45))
    brev.instances[instance_name(1)] = "RUNNING"
    sup.vault.update(1, segment_start=ago(50).isoformat(), segment_base=0)
    await sup.tick()
    await drain(sup)
    assert ("stop", instance_name(1)) in brev.calls
    assert store.rows[1]["status"] == "stopped"
    assert store.rows[1]["accruedCents"] > 0
    assert w["id"] == 1


async def test_guard_terminates_batch_jobs_at_the_platform_budget(tmp_path):
    brev = FakeBrev()
    sup, store, _ = make(tmp_path, brev, global_budget_cents=100)
    store.add(kind="batch", status="running", accruedCents=150, stoppable=False)
    brev.instances[instance_name(1)] = "RUNNING"
    await sup.tick()
    await drain(sup)
    assert ("delete", instance_name(1)) in brev.calls
    assert store.rows[1]["status"] == "terminated"


async def test_reconcile_deletes_only_orphans(tmp_path):
    brev = FakeBrev()
    sup, store, _ = make(tmp_path, brev)
    store.add(status="running")
    brev.instances = {instance_name(1): "RUNNING", "anywhere-dead": "RUNNING", "someone-elses-box": "RUNNING"}
    await sup.reconcile(await store.workloads())
    await sup.reconcile(await store.workloads())  # orphans are confirmed on a second pass
    assert set(brev.instances) == {instance_name(1), "someone-elses-box"}


async def test_reconcile_is_inert_outside_live_mode(tmp_path):
    brev = FakeBrev(mode=ProvisioningMode.DRY_RUN)
    sup, store, _ = make(tmp_path, brev)
    brev.instances = {"anywhere-dead": "RUNNING"}
    await sup.reconcile([])
    assert "anywhere-dead" in brev.instances


async def test_recover_fails_interrupted_work_and_cleans_up(tmp_path):
    brev = FakeBrev()
    sup, store, _ = make(tmp_path, brev)
    store.add(status="provisioning")
    brev.instances[instance_name(1)] = "DEPLOYING"
    await sup.recover()
    assert store.rows[1]["status"] == "failed"
    assert brev.instances == {}


async def test_one_operation_per_workload(tmp_path):
    brev = FakeBrev(fail_wait=True)
    sup, store, _ = make(tmp_path, brev)
    w = store.add()
    sup.launch(w)
    with pytest.raises(RuntimeError):
        sup.launch(w)
    await drain(sup)


async def test_running_training_job_is_guarded_and_stoppable(tmp_path):
    brev = FakeBrev()
    sup, store, _ = make(tmp_path, brev, max_session_hours=4)
    store.add(kind="batch", status="running", stoppable=False)
    sup.vault.update(1, instance=instance_name(1), segment_start=ago(5 * 60).isoformat(), segment_base=0)
    brev.instances[instance_name(1)] = "RUNNING"
    await sup.recover()  # reattaches the training monitor
    assert 1 in sup._monitors and not sup.busy(1)
    await sup.tick()  # 5 h > 4 h session limit: the guard must act despite the monitor
    await drain(sup)
    assert store.rows[1]["status"] == "terminated"
    assert ("delete", instance_name(1)) in brev.calls
    assert sup._monitors.get(1) is None or sup._monitors[1].done()


async def test_reconcile_spares_a_machine_created_mid_tick(tmp_path):
    brev = FakeBrev()
    sup, store, _ = make(tmp_path, brev)
    stale = [store.add(status="approved")]  # snapshot taken before the launch
    brev.instances[instance_name(1)] = "DEPLOYING"
    store.rows[1]["status"] = "provisioning"
    await sup.reconcile(stale)
    await sup.reconcile(stale)
    assert ("delete", instance_name(1)) not in brev.calls


async def test_reconcile_deletes_orphans_on_the_second_pass(tmp_path):
    brev = FakeBrev()
    sup, store, _ = make(tmp_path, brev)
    brev.instances[instance_name(99)] = "RUNNING"
    await sup.reconcile([])
    assert ("delete", instance_name(99)) not in brev.calls
    await sup.reconcile([])
    assert ("delete", instance_name(99)) in brev.calls


async def test_billing_survives_a_lost_vault(tmp_path):
    brev = FakeBrev()
    sup, store, _ = make(tmp_path, brev, max_session_hours=4)
    # No vault entry at all, as after a redeploy without its volume.
    store.add(kind="desktop", status="running", hourlyCents=100, startedAt=ago(5 * 60), lastActiveAt=ago(1))
    brev.instances[instance_name(1)] = "RUNNING"
    await sup.tick()
    await drain(sup)
    assert store.rows[1]["accruedCents"] >= 500  # 5 h at $1/h kept accruing
    assert store.rows[1]["status"] in ("stopped", "stopping", "saving")  # session limit enforced


async def test_stopping_a_desktop_does_not_bill_the_segment_twice(tmp_path):
    # Seen live: the bill is settled when a stop begins, but the row stays `stopping`
    # (billable) for minutes while Brev shuts down. The guard must not re-open the
    # segment from `startedAt` and add it on top of what was already settled.
    brev = FakeBrev()
    sup, store, _ = make(tmp_path, brev)
    w = store.add(kind="desktop", status="running", hourlyCents=100, startedAt=ago(30), lastActiveAt=ago(1))
    sup.vault.update(1, segment_start=ago(30).isoformat(), segment_base=0)
    await sup._settle_usage(w)
    settled = store.rows[1]["accruedCents"]
    assert 50 <= settled <= 51  # 30 min at $1/h
    store.rows[1]["status"] = "stopping"
    await sup.tick()
    await sup.tick()
    assert store.rows[1]["accruedCents"] == settled


async def test_brev_list_is_shared_and_invalidated_by_mutations(monkeypatch):
    from anywhere.brev import BrevCLI

    cli = BrevCLI("brev", "bak-test", ProvisioningMode.LIVE)
    calls: list[tuple] = []

    async def fake_run(*args, timeout=0):
        calls.append(args)
        await asyncio.sleep(0)
        return '{"workspaces": [{"name": "anywhere-1", "status": "RUNNING"}]}' if args[0] == "ls" else ""

    monkeypatch.setattr(cli, "_run", fake_run)
    a, b = await asyncio.gather(cli.list(), cli.list())
    await cli.get("anywhere-1")
    assert a == b and [c[0] for c in calls] == ["ls"]
    await cli.delete("anywhere-1")
    await cli.list()
    assert [c[0] for c in calls] == ["ls", "delete", "ls"]


async def test_platform_row_is_only_written_when_it_changes(tmp_path):
    brev = FakeBrev()
    sup, store, _ = make(tmp_path, brev)
    writes = []

    async def update_platform(*args):
        writes.append(args)

    store.update_platform = update_platform
    await sup.tick()
    await sup.tick()
    assert len(writes) == 1


class LocalRemote:
    """Runs the supervisor's shell snippets locally, against a temp directory."""

    def __init__(self, root):
        self.root = root

    async def run(self, command, *, timeout=120, input=None, check=True):
        from anywhere.remote import Result

        proc = await asyncio.create_subprocess_shell(
            command.replace("~/", f"{self.root}/"),
            stdin=asyncio.subprocess.PIPE if input is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            executable="/bin/bash",
        )
        out, err = await proc.communicate(input)
        return Result(proc.returncode or 0, out.decode(), err.decode())

    async def write_file(self, path, content, mode="0644"):
        await self.run(f"mkdir -p $(dirname {path}) && cat > {path} && chmod {mode} {path}", input=content)


async def test_streamed_setup_reads_new_output_and_reports_steps(tmp_path, monkeypatch):
    from anywhere import supervisor as mod
    from anywhere.remote import RemoteError

    real_sleep = asyncio.sleep
    monkeypatch.setattr(mod.asyncio, "sleep", lambda s: real_sleep(0.05))
    sup, store, _ = make(tmp_path, FakeBrev())
    w = store.add()
    remote = LocalRemote(tmp_path)
    ok = "echo '::step:: one'; sleep 0.1; printf 'partial'; sleep 0.1; echo ' line'; echo '::step:: two'"
    await sup._run_streamed(w, remote, ok, f"{mod.STATE_DIR}/ok.sh", timeout=20)
    assert [m for _, _, m in store.events] == ["one", "two"]

    bad = "echo '::step:: three'; echo 'boom detail'; exit 3"
    with pytest.raises(RemoteError, match="exited 3") as err:
        await sup._run_streamed(w, remote, bad, f"{mod.STATE_DIR}/bad.sh", timeout=20)
    assert "boom detail" in str(err.value)


async def test_vnc_tunnel_is_reopened_when_it_dies():
    import contextlib as cl

    from anywhere.desktop import VncTunnels

    opened: list[asyncio.base_events.Server] = []

    class R:
        @cl.asynccontextmanager
        async def tunnel(self, port):
            server = await asyncio.start_server(lambda r, w: w.close(), "127.0.0.1", 0)
            opened.append(server)
            try:
                yield server.sockets[0].getsockname()[1]
            finally:
                server.close()

    t = VncTunnels()
    p1 = await t.port_for(1, R())
    assert await t.port_for(1, R()) == p1 and len(opened) == 1
    opened[0].close()
    await opened[0].wait_closed()
    p2 = await t.port_for(1, R())
    assert len(opened) == 2 and p2 != p1
    await t.close_all()


async def test_recover_refreshes_ssh_before_reattaching(tmp_path):
    brev = FakeBrev()
    refreshed = []

    async def refresh_ssh():
        refreshed.append(True)

    brev.refresh_ssh = refresh_ssh
    sup, store, _ = make(tmp_path, brev)
    store.add(kind="batch", status="running")
    await sup.recover()
    assert refreshed == [True] and 1 in sup._monitors
    await sup.shutdown()


class ScriptedRemote(FakeRemote):
    """Answers the batch monitor's poll with a scripted sequence of job states."""

    polls: list[str] = []

    async def run(self, command, **kw):
        from anywhere.remote import Result

        if "::log::" in command:
            return Result(0, self.polls.pop(0) if self.polls else "", "")
        return Result(0, "file contents\n", "")

    def popen(self, command, **kw):
        return object()


class FakeStorage:
    def __init__(self):
        self.objects: dict[str, str] = {}

    async def upload_stream(self, proc, key, content_type):
        self.objects[key] = content_type
        return 1234

    async def put_bytes(self, key, data, content_type):
        self.objects[key] = content_type


def poll_output(offset=0, log="", metrics=(), status="", alive="yes"):
    import base64

    rows = "".join(m + "\n" for m in metrics)
    b64 = base64.b64encode(log.encode()).decode()
    return f"::log::{b64}\n::metrics::\n{rows}::status::\n{status}\n::alive::\n{alive}\n"


async def test_batch_monitor_streams_logs_metrics_and_registers_artifacts(tmp_path):
    import json as _json

    brev = FakeBrev()
    sup, store, notes = make(tmp_path, brev)
    sup.poll_seconds = 0
    sup.storage = FakeStorage()
    sup.remote_factory = ScriptedRemote
    ScriptedRemote.polls = [
        poll_output(20, "::step:: Training\n", [_json.dumps({"step": 5, "loss": 2.0, "max_steps": 10})]),
        poll_output(40, "more log\n", [_json.dumps({"step": 10, "loss": 1.0, "max_steps": 10})], status="succeeded"),
    ]
    w = store.add(kind="batch", status="running")
    brev.instances[instance_name(1)] = "RUNNING"
    await sup._monitor_batch(w)
    assert [t for _, t in store.logs] == ["::step:: Training\n", "more log\n"]
    assert {(p["name"], p["step"]) for p in store.metrics} >= {("loss", 5), ("loss", 10), ("progress", 10)}
    assert sup.vault.get(1)["log_offset"] == len(b"::step:: Training\nmore log\n")
    assert store.rows[1]["status"] == "succeeded"
    names = [a[2] for a in store.artifacts]
    assert names[0] == "LoRA adapter" and "Metrics" in names
    assert ("delete", instance_name(1)) in brev.calls


async def test_batch_monitor_fails_when_runner_dies_silently(tmp_path):
    brev = FakeBrev()
    sup, store, _ = make(tmp_path, brev)
    sup.poll_seconds = 0
    sup.remote_factory = ScriptedRemote
    ScriptedRemote.polls = [poll_output(0, alive="no")] * 3
    w = store.add(kind="batch", status="running")
    await sup._monitor_batch(w)
    assert store.rows[1]["status"] == "failed"
    assert "stopped unexpectedly" in store.rows[1]["statusDetail"]


async def test_batch_monitor_fails_when_the_job_directory_is_gone(tmp_path):
    brev = FakeBrev()
    sup, store, _ = make(tmp_path, brev)
    sup.poll_seconds = 0
    sup.remote_factory = ScriptedRemote
    ScriptedRemote.polls = ["::missing::\n"] * 3
    w = store.add(kind="batch", status="running")
    await sup._monitor_batch(w)
    assert store.rows[1]["status"] == "failed"


async def test_batch_monitor_gives_up_on_a_runner_that_never_starts(tmp_path):
    from anywhere import supervisor as sup_mod

    brev = FakeBrev()
    sup, store, _ = make(tmp_path, brev)
    sup.poll_seconds = 0
    sup.remote_factory = ScriptedRemote
    ScriptedRemote.polls = [poll_output(alive="starting")] * (sup_mod.STARTING_POLL_LIMIT + 3)
    w = store.add(kind="batch", status="running")
    await sup._monitor_batch(w)
    assert store.rows[1]["status"] == "failed"


async def test_batch_monitor_retries_a_failed_log_write(tmp_path):
    brev = FakeBrev()
    sup, store, _ = make(tmp_path, brev)
    sup.poll_seconds = 0
    sup.storage = FakeStorage()
    sup.remote_factory = ScriptedRemote
    ScriptedRemote.polls = [
        poll_output(log="first\n"),
        poll_output(log="first\n"),  # same bytes come back because the offset didn't move
        poll_output(log="", status="succeeded"),
    ]
    w = store.add(kind="batch", status="running")
    brev.instances[instance_name(1)] = "RUNNING"
    real = store.append_logs
    calls = {"n": 0}

    async def flaky(wid, text):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("spacetime blip")
        await real(wid, text)

    store.append_logs = flaky
    await sup._monitor_batch(w)
    assert [t for _, t in store.logs] == ["first\n"]
    assert sup.vault.get(1)["log_offset"] == len(b"first\n")


async def test_a_slow_desktop_does_not_block_other_vnc_connects():
    import contextlib as cl

    from anywhere.desktop import VncTunnels

    gate = asyncio.Event()

    class Slow:
        @cl.asynccontextmanager
        async def tunnel(self, port):
            await gate.wait()
            yield 1

    class Fast:
        @cl.asynccontextmanager
        async def tunnel(self, port):
            yield 2

    t = VncTunnels()
    slow = asyncio.create_task(t.port_for(1, Slow()))
    await asyncio.sleep(0)
    assert await asyncio.wait_for(t.port_for(2, Fast()), 1) == 2
    gate.set()
    assert await slow == 1


class _GpuRemote(FakeRemote):
    out = "87, 6144, 23034, 61, 72.45\n"

    async def run(self, command, **kw):
        from anywhere.remote import Result

        return Result(0, self.out, "") if command.startswith("nvidia-smi") else Result(0, "", "")


def test_parses_nvidia_smi_and_skips_unavailable_fields():
    from anywhere.supervisor import parse_gpu_query

    assert parse_gpu_query("87, 6144, 23034, 61, 72.45\n") == {
        "util_pct": 87.0,
        "mem_used_gb": 6.0,
        "mem_total_gb": 22.49,
        "temp_c": 61.0,
        "power_w": 72.45,
    }
    assert parse_gpu_query("3, 512, 15360, 40, [N/A]")["util_pct"] == 3.0
    assert "power_w" not in parse_gpu_query("3, 512, 15360, 40, [N/A]")
    assert parse_gpu_query("NVIDIA-SMI has failed") is None
    assert parse_gpu_query("") is None
    # Multi-GPU machines report the first GPU.
    assert parse_gpu_query("10, 1024, 2048, 30, 20\n90, 1024, 2048, 70, 200\n")["util_pct"] == 10.0


async def test_gpu_samples_are_stored_as_metrics_with_elapsed_seconds(tmp_path):
    s = Settings(_env_file=None, brev_api_key="bak-test", data_dir=tmp_path)
    store = FakeStore()
    stored: list[dict] = []

    async def add_metrics(wid, points):
        stored.extend(points)

    store.add_metrics = add_metrics

    async def notify(*_):
        return None

    sup = Supervisor(s, store, FakeBrev(), Storage(s), Vault(tmp_path / "v.json"), notify, remote_factory=_GpuRemote)
    w = store.add(status="running", startedAt=ago(2))
    first = await sup.sample_gpu(w)
    names = {p["name"] for p in first}
    assert names == {"gpu.util_pct", "gpu.mem_used_gb", "gpu.mem_total_gb", "gpu.temp_c", "gpu.power_w"}
    assert all(115 <= p["step"] <= 125 for p in first)  # ~2 minutes since start
    second = await sup.sample_gpu(w)
    assert "gpu.mem_total_gb" not in {p["name"] for p in second}  # the total is sent once
    assert len(stored) == len(first) + len(second)


async def test_only_running_machines_are_sampled(tmp_path):
    sup, store, _ = make(tmp_path, FakeBrev())
    store.add(id=1, status="running")
    store.add(id=2, status="stopped")
    store.add(id=3, status="provisioning")
    await sup.tick()
    assert set(sup._sampling) == {1}


async def test_telemetry_samples_machines_concurrently(tmp_path):
    sup, store, _ = make(tmp_path, FakeBrev(), gpu_telemetry_seconds=60)
    for i in (1, 2, 3):
        store.add(id=i, status="running")
    await sup.tick()
    sup._gpu_total_sent = {1, 99}  # 99 stopped long ago
    started: list[int] = []

    async def slow_sample(w):
        started.append(w["id"])
        await asyncio.sleep(0.3)
        return []

    sup.sample_gpu = slow_sample
    task = asyncio.create_task(sup._telemetry_loop())
    await asyncio.sleep(0.1)
    # A slow machine doesn't hold up the others: all three are being sampled at once.
    assert sorted(started) == [1, 2, 3]
    assert sup._gpu_total_sent == {1}
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def test_telemetry_can_be_turned_off(tmp_path):
    sup, _, _ = make(tmp_path, FakeBrev(), gpu_telemetry_seconds=0)
    sup.start_guard()
    assert sup._telemetry_task is None
    await sup.shutdown()
    await asyncio.gather(sup._guard_task, return_exceptions=True)


def test_desktop_setup_falls_back_to_blender_mirrors():
    import subprocess

    from anywhere.supervisor import _env, render

    script = render(
        _env("desktop-setup.sh"), DESKTOP_IMAGE="img", BLENDER_VERSION="4.5.15", BLENDER_SHA256="x", CUA_TOKEN="t"
    )
    assert subprocess.run(["bash", "-n"], input=script.encode()).returncode == 0
    for mirror in ("download.blender.org", "mirrors.ocf.berkeley.edu", "ftp.nluug.nl"):
        assert mirror in script
    assert "--retry" in script and "sha256sum -c" in script


async def test_setup_failures_keep_the_last_output_on_the_machine_log(tmp_path):
    from anywhere.remote import RemoteError

    sup, store, _ = make(tmp_path, FakeBrev())
    logs: list[str] = []

    async def append_logs(wid, text):
        logs.append(text)

    store.append_logs = append_logs
    w = store.add(status="configuring")
    await sup._fail(w, RemoteError("desktop-setup.sh exited 22\ncurl: (22) The requested URL returned error: 403"))
    assert store.rows[1]["statusDetail"] == "desktop-setup.sh exited 22"
    assert logs and "returned error: 403" in logs[0]


class _LocalShell:
    """A Remote stand-in that runs commands on this host."""

    def popen(self, command, *, stdin=None, stdout=None):
        import subprocess

        return subprocess.Popen(["sh", "-c", command], stdin=stdin, stdout=stdout, stderr=subprocess.DEVNULL)


async def test_relay_does_not_hang_when_the_receiver_exits_early():
    from anywhere.remote import RemoteError
    from anywhere.supervisor import _relay

    # The receiver reads 10 bytes and exits; the sender has ~200 MB to send.
    with pytest.raises(RemoteError):
        await asyncio.wait_for(
            _relay(_LocalShell(), "yes | head -c 200000000", _LocalShell(), "head -c 10 >/dev/null; exit 3"), 20
        )


async def test_relay_times_out_and_kills_both_sides():
    from anywhere.remote import RemoteError
    from anywhere.supervisor import _relay

    with pytest.raises(RemoteError, match="too long"):
        await _relay(_LocalShell(), "sleep 30", _LocalShell(), "cat >/dev/null", timeout=0.5)


async def test_relay_copies_between_machines(tmp_path):
    from anywhere.supervisor import _relay

    out = tmp_path / "out"
    await _relay(_LocalShell(), "printf hello", _LocalShell(), f"cat > {out}")
    assert out.read_text() == "hello"


def test_housekeeping_drops_vault_records_nothing_will_read(tmp_path):
    from datetime import UTC, datetime, timedelta

    from anywhere import savings, sharing

    sup, _, _ = make(tmp_path, FakeBrev())
    now = datetime.now(UTC)
    v = sup.vault
    v.section_put(sharing.SECTION, "live", {"workload_id": 1, "expires_at": (now + timedelta(hours=1)).isoformat()})
    v.section_put(sharing.SECTION, "old", {"workload_id": 2, "expires_at": (now - timedelta(minutes=1)).isoformat()})
    v.section_put("notification_attachments", "1", {"key": "k", "name": "a.jpg", "at": now.isoformat()})
    v.section_put(
        "notification_attachments", "2", {"key": "k", "name": "a.jpg", "at": (now - timedelta(days=2)).isoformat()}
    )
    v.section_put("notification_attachments", "3", {"key": "k", "name": "a.jpg"})  # written before timestamps
    v.section_put(savings.SECTION, "recent", {"stopped_at": (now - timedelta(days=3)).isoformat()})
    v.section_put(savings.SECTION, "ancient", {"stopped_at": (now - timedelta(days=200)).isoformat()})

    assert sup.housekeeping(now) == 4
    assert [k for k, _ in v.section_items(sharing.SECTION)] == ["live"]
    assert [k for k, _ in v.section_items("notification_attachments")] == ["1"]
    assert [k for k, _ in v.section_items(savings.SECTION)] == ["recent"]
    assert sup.housekeeping(now) == 0
