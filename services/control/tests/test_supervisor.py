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


class ScriptedRemote(FakeRemote):
    """Answers the batch monitor's poll with a scripted sequence of job states."""

    polls: list[str] = []

    async def run(self, command, **kw):
        from anywhere.remote import Result

        if "::offset::" in command:
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


def poll_output(offset, log="", metrics=(), status="", alive="yes"):
    rows = "".join(m + "\n" for m in metrics)
    return f"::offset::{offset}\n{log}\n::metrics::\n{rows}::status::\n{status}\n::alive::\n{alive}\n"


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
    assert sup.vault.get(1)["log_offset"] == 40
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
