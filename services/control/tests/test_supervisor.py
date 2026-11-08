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
