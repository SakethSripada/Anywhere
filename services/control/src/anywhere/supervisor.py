"""Workload supervisor: everything that happens after a plan is approved.

Runs as background asyncio tasks inside the control plane, so nothing depends
on an HTTP request (or a browser tab) staying open. SpacetimeDB holds the
durable state; on restart `recover()` reattaches to running work and fails
anything that was interrupted mid-provisioning, cleaning up its instance.

Every path that can create compute has a matching cleanup path:
  * provisioning/configuration errors → save what we can → delete the instance
  * the budget guard → save → stop (desktops) or delete (batch)
  * reconciliation → delete `anywhere-*` instances no workload owns
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import re
import subprocess
import tempfile
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib import resources
from pathlib import Path
from typing import Any

import structlog

from . import budget
from .brev import BrevCLI, BrevError, ProvisioningDisabled, instance_name
from .config import ProvisioningMode, Settings
from .desktop import VncTunnels, connect_screen
from .ids import new_id
from .lifecycle import BILLABLE, Status
from .remote import Remote, RemoteError
from .stdb import ReducerRejected
from .storage import Storage, StorageUnavailable
from .store import Store
from .training import TrainConfig
from .vault import Vault

log = structlog.get_logger()

JOB_DIR = "~/workspace/anywhere/job"
#: Polls a batch job may report "starting" (no pid file yet) before it counts as dead.
STARTING_POLL_LIMIT = 6
#: How often the guard looks for orphaned Brev instances.
RECONCILE_SECONDS = 120
STATE_DIR = "~/workspace/anywhere/state"
PROJECTS_DIR = "~/workspace/anywhere/projects"

#: Blender's published checksum for the pinned release (download.blender.org).
BLENDER_SHA256 = {"4.5.15": "0d2b8bb2efe97e6c8eb57de6b7322f8800e1984e3125b60decca5f6771e4773e"}


def _env(name: str) -> str:
    return resources.files("anywhere.environments").joinpath(name).read_text()


def render(template: str, **values: str) -> str:
    out = template
    for key, value in values.items():
        out = out.replace("{{" + key + "}}", value)
    if leftover := re.findall(r"\{\{(\w+)\}\}", out):
        raise ValueError(f"Unrendered template values: {leftover}")
    return out


Notify = Callable[[dict, str, str], Awaitable[None]]


@dataclass
class Supervisor:
    settings: Settings
    store: Store
    brev: BrevCLI
    storage: Storage
    vault: Vault
    notify: Notify
    remote_factory: Callable[[str], Remote] = Remote

    poll_seconds: float = 10
    #: Integration readiness mirrored to the platform row (Anywhere wires in live checks).
    integrations: Callable[[], dict[str, bool]] | None = None

    def __post_init__(self) -> None:
        self._tasks: dict[int, asyncio.Task] = {}
        self._agents: dict[int, asyncio.Task] = {}
        #: Batch-job monitors. Kept apart from `_tasks` (which means "a lifecycle
        #: operation is in progress") so the guard and Stop can still act on a
        #: running training job.
        self._monitors: dict[int, asyncio.Task] = {}
        self._locks: dict[int, asyncio.Lock] = {}
        self.vnc = VncTunnels()
        self._guard_task: asyncio.Task | None = None
        #: Unowned instances seen on the previous reconcile pass. An instance is only
        #: deleted after it is unowned on two passes in a row.
        self._orphan_candidates: set[str] = set()
        self._last_reconcile = 0.0
        self._last_platform: tuple | None = None

    # ── Task plumbing ─────────────────────────────────────────────────────

    def _lock(self, wid: int) -> asyncio.Lock:
        return self._locks.setdefault(wid, asyncio.Lock())

    def _spawn(self, wid: int, coro: Awaitable[Any], *, name: str) -> None:
        if (t := self._tasks.get(wid)) and not t.done():
            coro.close()  # type: ignore[attr-defined]
            raise RuntimeError("This workload already has an operation in progress")
        task = asyncio.create_task(coro, name=f"{name}:{wid}")
        self._tasks[wid] = task
        task.add_done_callback(lambda t: self._on_done(wid, t))

    def _on_done(self, wid: int, task: asyncio.Task) -> None:
        if not task.cancelled() and (exc := task.exception()):
            log.error("supervisor.task_crashed", workload=wid, error=repr(exc))

    def busy(self, wid: int) -> bool:
        t = self._tasks.get(wid)
        return bool(t and not t.done())

    def _start_monitor(self, w: dict) -> None:
        if (t := self._monitors.get(w["id"])) and not t.done():
            return
        task = asyncio.create_task(self._monitor_batch(w), name=f"monitor:{w['id']}")
        self._monitors[w["id"]] = task
        task.add_done_callback(lambda t: self._on_done(w["id"], t))

    async def _stop_monitor(self, wid: int) -> None:
        t = self._monitors.pop(wid, None)
        if t and not t.done() and t is not asyncio.current_task():
            t.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t

    async def _transition(self, w: dict, to: Status, detail: str) -> None:
        await self.store.transition(w["id"], to.value, detail)
        w["status"] = to.value
        if to == Status.PROVISIONING:
            # Billing segment begins; remember what was already billed.
            self.vault.update(w["id"], segment_base=int(w.get("accruedCents", 0)), segment_start=_now().isoformat())

    async def _event(self, w: dict, message: str, level: str = "info") -> None:
        try:
            await self.store.add_event(w["id"], level, message)
        except Exception as exc:  # telemetry must never break a workflow
            log.warning("supervisor.event_failed", error=str(exc))

    def remote(self, w: dict) -> Remote:
        name = self.vault.get(w["id"]).get("instance") or instance_name(w["id"])
        return self.remote_factory(name)

    # ── Entry points ──────────────────────────────────────────────────────

    def launch(self, w: dict) -> None:
        self._spawn(w["id"], self._launch(w), name="launch")

    def stop(self, w: dict, reason: str = "Stopped by you") -> None:
        self._spawn(w["id"], self._stop(w, reason), name="stop")

    def resume(self, w: dict) -> None:
        self._spawn(w["id"], self._resume(w), name="resume")

    def terminate(self, w: dict, reason: str = "Deleted by you") -> None:
        self._spawn(w["id"], self._terminate(w, reason), name="terminate")

    def save(self, w: dict) -> None:
        self._spawn(w["id"], self._save_running(w), name="save")

    # ── Launch ────────────────────────────────────────────────────────────

    async def _launch(self, w: dict) -> None:
        async with self._lock(w["id"]):
            name = instance_name(w["id"])
            self.vault.update(w["id"], instance=name, owner=w["owner"])
            plan = json.loads(w["planJson"])
            try:
                await self._transition(w, Status.PROVISIONING, f"Requesting a {w['gpuName']} from Brev")
                with _script(render(_env("boot.sh"), PREPULL_IMAGE=self._prepull(w))) as boot:
                    created = await self.brev.create(name, w["instanceType"], boot)
                if created.dry_run:
                    await self._event(w, "Dry run: Brev accepted this request. No machine was created.", "success")
                    await self._transition(w, Status.CANCELLED, "Dry run complete — nothing was billed")
                    await self.notify(
                        w, "status", "Dry run complete: Brev validated the plan. Switch to live mode to run it."
                    )
                    return
                await self._event(w, f"Machine requested ({w['instanceType']}). Waiting for it to boot…")
                await self.brev.wait_for(name, want="RUNNING", timeout=25 * 60)
                await self.brev.refresh_ssh()
                remote = self.remote(w)
                await _until(remote.reachable, timeout=6 * 60, what="SSH access")

                await self._transition(w, Status.CONFIGURING, "Setting up the environment")
                if w["kind"] == "desktop":
                    await self._configure_desktop(w, remote)
                else:
                    await self._configure_batch(w, remote, plan)
            except ProvisioningDisabled as exc:
                await self._event(w, str(exc), "warn")
                await self._transition(w, Status.CANCELLED, str(exc))
                await self.notify(w, "error", f"Couldn't start: {exc}")
                return
            except Exception as exc:
                await self._fail(w, exc)
                return

        if w["kind"] == "desktop":
            await self.notify(w, "status", f"Your {w['title']} is ready.")
        else:
            self._start_monitor(w)

    def _prepull(self, w: dict) -> str:
        return self.settings.desktop_image if w["kind"] == "desktop" else "hello-world"

    async def _run_streamed(self, w: dict, remote: Remote, script: str, path: str, timeout: float) -> None:
        """Run a pushed script detached and mirror its `::step::` markers into events."""
        await remote.write_file(path, script.encode(), mode="0755")
        log_path = f"{STATE_DIR}/{Path(path).stem}.out"
        # nohup + full redirection: the job must outlive this SSH session.
        await remote.run(
            f"rm -f {log_path}.exit; nohup sh -c 'bash {path} > {log_path} 2>&1; echo $? > {log_path}.exit'"
            " </dev/null >/dev/null 2>&1 &",
            timeout=30,
        )
        # Only fetch what was appended since the last poll: the setup log can grow to
        # megabytes during image pulls, and it used to be re-read in full every 5 s.
        offset = 0
        partial = ""
        recent: list[str] = []
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(5)
            out = (
                await remote.run(
                    # Read the exit file first: if it exists, the log is complete.
                    f"ex=$(cat {log_path}.exit 2>/dev/null); sz=$(wc -c < {log_path} 2>/dev/null || echo 0); "
                    f"tail -c +{offset + 1} {log_path} 2>/dev/null | head -c $((sz - {offset})); "
                    f'echo; echo "::size::$sz"; echo "$ex"',
                    check=False,
                )
            ).stdout
            body, _, meta = out.rpartition("\n::size::")
            size_txt, _, exit_txt = meta.partition("\n")
            if not size_txt.strip().isdigit():
                continue
            offset = max(offset, int(size_txt.strip()))
            chunk = partial + body  # the separator consumed the newline `echo` added
            *lines, partial = chunk.split("\n")
            recent = (recent + lines)[-15:]
            for ln in lines:
                if "::step::" in ln:
                    await self._event(w, ln.split("::step::", 1)[1].strip())
                if "::error::" in ln:
                    raise RemoteError(ln.split("::error::", 1)[1].strip())
            exit_code = exit_txt.strip()
            if exit_code.isdigit():
                if exit_code != "0":
                    tail = "\n".join([*recent, partial][-15:])
                    raise RemoteError(f"{Path(path).name} exited {exit_code}\n{tail}")
                return
        raise RemoteError(f"{Path(path).name} did not finish within {timeout / 60:.0f} minutes")

    async def _configure_desktop(self, w: dict, remote: Remote) -> None:
        token = self.vault.agent_token(w["id"])
        version = self.settings.blender_version
        setup = render(
            _env("desktop-setup.sh"),
            DESKTOP_IMAGE=self.settings.desktop_image,
            BLENDER_VERSION=version,
            BLENDER_SHA256=BLENDER_SHA256.get(version, ""),
            CUA_TOKEN=token,
        )
        await self._run_streamed(w, remote, setup, f"{STATE_DIR}/desktop-setup.sh", timeout=30 * 60)
        await self._restore_project(w, remote)
        await self._start_desktop(w, remote)

    async def _start_desktop(self, w: dict, remote: Remote) -> None:
        await self._event(w, "Starting the desktop session")
        result = await remote.run("bash -s", input=_env("desktop-start.sh").encode(), timeout=150)
        if "::ready::" not in result.stdout:
            raise RemoteError("Desktop services did not report ready")
        await self._transition(w, Status.RUNNING, "Desktop is live")
        await self.store.record_usage(w["id"], int(w.get("accruedCents", 0)), touch=True)
        plan = json.loads(w["planJson"])
        if plan.get("intent", {}).get("application") == "blender":
            with contextlib.suppress(Exception):
                async with connect_screen(remote, self.vault.agent_token(w["id"])) as screen:
                    await screen.shell("cd ~/Projects && DISPLAY=:1 nohup blender >/tmp/blender.log 2>&1 &", timeout=10)
                await self._event(w, "Blender is open")

    # ── Projects ──────────────────────────────────────────────────────────

    def _project(self, w: dict) -> tuple[int, str]:
        pid = int(w.get("projectId") or 0) or w["id"]
        return pid, Storage.project_key(w["owner"], pid)

    async def _restore_project(self, w: dict, remote: Remote) -> None:
        if not self.settings.storage_ready:
            return
        pid, key = self._project(w)
        if not await self.storage.head(key):
            return
        await self._event(w, "Restoring your saved project files")
        proc = remote.popen(f"mkdir -p {PROJECTS_DIR} && tar -xzf - -C {PROJECTS_DIR}", stdin=subprocess.PIPE)
        await self.storage.download_stream(key, proc)

    async def snapshot_project(self, w: dict, remote: Remote) -> int | None:
        """Stream ~/workspace/anywhere/projects to object storage. Returns bytes written."""
        if not self.settings.storage_ready:
            await self._event(w, "Object storage isn't configured; files stay on the machine's disk only.", "warn")
            return None
        pid, key = self._project(w)
        proc = remote.popen(f"tar -czf - -C {PROJECTS_DIR} .", stdout=subprocess.PIPE)
        size = await self.storage.upload_stream(proc, key, "application/gzip")
        await self.store.upsert_project(pid, w["owner"], w["title"], "blender", key, size, True)
        await self._event(w, f"Project saved ({size / 1e6:.1f} MB)", "success")
        return size

    async def _save_running(self, w: dict) -> None:
        async with self._lock(w["id"]):
            try:
                await self._transition(w, Status.SAVING, "Saving project files")
                await self.snapshot_project(w, self.remote(w))
                await self._transition(w, Status.RUNNING, "Desktop is live")
            except Exception as exc:
                await self._event(w, f"Save failed: {exc}", "error")
                with contextlib.suppress(Exception):
                    await self._transition(w, Status.RUNNING, "Desktop is live (last save failed)")

    # ── Stop / resume / terminate ─────────────────────────────────────────

    async def _stop(self, w: dict, reason: str) -> None:
        await self._stop_monitor(w["id"])
        async with self._lock(w["id"]):
            await self.stop_agent(w["id"])
            await self.vnc.close(w["id"])
            remote = self.remote(w)
            if w["kind"] == "desktop" and w["status"] == Status.RUNNING:
                await self._transition(w, Status.SAVING, "Saving before stopping")
                try:
                    await self.snapshot_project(w, remote)
                except Exception as exc:
                    # The disk persists across a stop, so a failed upload is not data loss.
                    await self._event(
                        w, f"Couldn't upload a snapshot ({exc}); files remain on the stopped disk.", "warn"
                    )
            await self._transition(w, Status.STOPPING, reason)
            name = self.vault.get(w["id"]).get("instance") or instance_name(w["id"])
            await self._settle_usage(w)
            try:
                if w["stoppable"] and w["kind"] == "desktop":
                    await self.brev.stop(name)
                    await self.brev.wait_for(name, want="STOPPED", timeout=10 * 60)
                    await self._transition(w, Status.STOPPED, reason)
                    await self.notify(w, "status", f"{w['title']} stopped. Your files are saved — resume anytime.")
                else:
                    await self.brev.delete(name)
                    await self._transition(w, Status.TERMINATED, reason)
            except Exception as exc:
                await self._event(w, f"Stopping failed: {exc}. Deleting the machine instead.", "error")
                await self._force_delete(w, name, "Deleted after a failed stop")

    async def _resume(self, w: dict) -> None:
        async with self._lock(w["id"]):
            name = self.vault.get(w["id"]).get("instance") or instance_name(w["id"])
            try:
                await self._transition(w, Status.PROVISIONING, "Resuming your machine")
                await self.brev.start(name)
                await self.brev.wait_for(name, want="RUNNING", timeout=20 * 60)
                await self.brev.refresh_ssh()
                remote = self.remote(w)
                await _until(remote.reachable, timeout=6 * 60, what="SSH access")
                await self._transition(w, Status.CONFIGURING, "Reconnecting the desktop")
                await self._start_desktop(w, remote)
            except Exception as exc:
                await self._fail(w, exc)
                return
        await self.notify(w, "status", f"{w['title']} is back online.")

    async def _terminate(self, w: dict, reason: str) -> None:
        await self._stop_monitor(w["id"])
        async with self._lock(w["id"]):
            await self.stop_agent(w["id"])
            await self.vnc.close(w["id"])
            name = self.vault.get(w["id"]).get("instance") or instance_name(w["id"])
            if w["status"] == Status.RUNNING and w["kind"] == "desktop":
                await self._transition(w, Status.SAVING, "Saving before deleting")
                with contextlib.suppress(Exception):
                    await self.snapshot_project(w, self.remote(w))
            if w["status"] in (Status.RUNNING, Status.SAVING):
                await self._transition(w, Status.STOPPING, reason)
            await self._settle_usage(w)
            await self._force_delete(w, name, reason)

    async def _force_delete(self, w: dict, name: str, reason: str, final: Status | None = Status.TERMINATED) -> None:
        """Delete the instance (retrying), then optionally settle the workload in `final`."""
        for attempt in range(3):
            try:
                if await self.brev.get(name):
                    await self.brev.delete(name)
                break
            except BrevError as exc:
                log.warning("supervisor.delete_retry", workload=w["id"], attempt=attempt, error=str(exc))
                await asyncio.sleep(10 * (attempt + 1))
        else:
            await self._event(w, f"Could not delete {name}; the reconciler will retry.", "error")
        if final is None:
            return
        if final == Status.TERMINATED and w["status"] not in (
            Status.STOPPING,
            Status.STOPPED,
            Status.FAILED,
            Status.SUCCEEDED,
        ):
            with contextlib.suppress(ReducerRejected):
                await self._transition(w, Status.FAILED, reason)
        with contextlib.suppress(ReducerRejected):
            await self._transition(w, final, reason)

    async def _fail(self, w: dict, exc: Exception) -> None:
        message = str(exc).strip().splitlines()[0][:300] if str(exc).strip() else exc.__class__.__name__
        log.error("supervisor.failed", workload=w["id"], error=repr(exc))
        await self._event(w, message, "error")
        if asyncio.current_task() is not self._agents.get(w["id"]):
            await self.stop_agent(w["id"])
        await self.vnc.close(w["id"])
        name = self.vault.get(w["id"]).get("instance") or instance_name(w["id"])
        await self._settle_usage(w)
        with contextlib.suppress(ReducerRejected):
            await self._transition(w, Status.FAILED, message)
        await self.notify(w, "error", f"{w['title']} failed: {message}")
        # Never leave a billing machine behind after a failure.
        if self.brev.api_key and self.settings.provisioning_mode == ProvisioningMode.LIVE:
            await self._force_delete(w, name, "Cleaned up after failure", final=None)

    # ── Batch ─────────────────────────────────────────────────────────────

    async def _configure_batch(self, w: dict, remote: Remote, plan: dict) -> None:
        inputs = plan.get("inputs", {})
        cfg = TrainConfig.model_validate(inputs["train_config"])
        key = inputs["dataset_key"]
        ext = "jsonl" if cfg.dataset_format == "jsonl" else "csv"
        await self._event(w, "Uploading your dataset to the machine")
        proc = remote.popen(f"mkdir -p {JOB_DIR} && cat > {JOB_DIR}/data.{ext}", stdin=subprocess.PIPE)
        await self.storage.download_stream(key, proc)
        cfg = cfg.model_copy(update={"dataset_path": f"data.{ext}"})
        await remote.write_file(f"{JOB_DIR}/config.json", cfg.model_dump_json(indent=2).encode())
        await remote.write_file(f"{JOB_DIR}/train.py", _env("train.py").encode())
        await remote.write_file(f"{JOB_DIR}/run.sh", _env("batch-run.sh").encode(), mode="0755")
        await remote.run(
            f"cd {JOB_DIR} && rm -f status metrics.jsonl run.log pid && (nohup bash run.sh </dev/null >/dev/null 2>&1 &)"
        )
        self.vault.update(w["id"], log_offset=0, metric_lines=0)
        await self._transition(w, Status.RUNNING, f"Fine-tuning {cfg.base_model.split('/')[-1]}")
        await self.notify(w, "status", f"Training started on a {w['gpuName']}. I'll message you when it's done.")

    async def _monitor_batch(self, w: dict) -> None:
        """Mirror the job's log, metrics and status into SpacetimeDB until it ends.

        Offsets are persisted in the vault so a control-plane restart resumes
        where it left off instead of re-appending the whole log."""
        remote = self.remote(w)
        v = self.vault.get(w["id"])
        log_offset, metric_lines = int(v.get("log_offset", 0)), int(v.get("metric_lines", 0))
        failures = 0
        dead_polls = 0
        starting_polls = 0
        while True:
            await asyncio.sleep(self.poll_seconds)
            try:
                res = await remote.run(poll_command(log_offset, metric_lines), timeout=60)
                failures = 0
            except RemoteError as exc:
                failures += 1
                if failures >= 6:
                    await self._fail(w, RemoteError(f"Lost contact with the training machine: {exc}"))
                    return
                continue
            poll = parse_poll(res.stdout, log_offset)
            # Offsets only advance once the data is stored, so a failed write is
            # retried on the next poll instead of being skipped for good.
            if poll.log:
                try:
                    await self.store.append_logs(w["id"], poll.log)
                    log_offset = max(log_offset, poll.offset)
                    for marker in re.findall(r"::step:: (.+)", poll.log):
                        await self._event(w, marker.strip())
                except Exception as exc:
                    log.warning("supervisor.write_failed", error=str(exc))
            else:
                log_offset = max(log_offset, poll.offset)
            points = metric_points(poll.metric_rows)
            if points:
                try:
                    await self.store.add_metrics(w["id"], points)
                    metric_lines += len(poll.metric_rows)
                except Exception as exc:
                    log.warning("supervisor.write_failed", error=str(exc))
                await _safe(self.store.record_usage(w["id"], self._accrued(w), touch=True))
            else:
                metric_lines += len(poll.metric_rows)
            v = self.vault.get(w["id"])
            if (v.get("log_offset"), v.get("metric_lines")) != (log_offset, metric_lines):
                self.vault.update(w["id"], log_offset=log_offset, metric_lines=metric_lines)
            if poll.status == "succeeded":
                await self._finish_batch(w, remote)
                return
            if poll.status.startswith("failed"):
                await self._fail(w, RemoteError(poll.status.removeprefix("failed:").strip() or "Training failed"))
                return
            # The runner died without writing a status (OOM kill, reboot), the job
            # directory vanished, or the runner never started: don't bill forever.
            if not poll.found or poll.alive == "no":
                dead_polls += 1
            elif poll.alive == "starting":
                starting_polls += 1
                dead_polls = dead_polls + 1 if starting_polls > STARTING_POLL_LIMIT else 0
            else:
                dead_polls = 0
            if dead_polls >= 3:
                await self._fail(w, RemoteError("The training process stopped unexpectedly. See the log for details."))
                return

    async def _finish_batch(self, w: dict, remote: Remote) -> None:
        async with self._lock(w["id"]):
            await self._event(w, "Training finished. Saving outputs")
            try:
                adapter_key = Storage.artifact_key(w["owner"], w["id"], "adapter.tar.gz")
                proc = remote.popen(f"tar -czf - -C {JOB_DIR}/outputs adapter", stdout=subprocess.PIPE)
                size = await self.storage.upload_stream(proc, adapter_key, "application/gzip")
                await self.store.add_artifact(new_id(), w["id"], "LoRA adapter", adapter_key, "application/gzip", size)
                for name, ctype, path in (
                    ("Training log", "text/plain", f"{JOB_DIR}/run.log"),
                    ("Metrics", "application/x-ndjson", f"{JOB_DIR}/metrics.jsonl"),
                    ("Sample generations", "application/json", f"{JOB_DIR}/outputs/samples.json"),
                ):
                    data = (await remote.run(f"cat {path}", check=False, timeout=60)).stdout.encode()
                    if data:
                        key = Storage.artifact_key(w["owner"], w["id"], Path(path).name)
                        await self.storage.put_bytes(key, data, ctype)
                        await self.store.add_artifact(new_id(), w["id"], name, key, ctype, len(data))
                await self._transition(w, Status.SUCCEEDED, "Training complete")
            except Exception as exc:
                await self._fail(w, exc)
                return
            await self._settle_usage(w)
            name = self.vault.get(w["id"]).get("instance") or instance_name(w["id"])
            await self._force_delete(w, name, "Machine released after training", final=None)
        await self.notify(w, "status", f"{w['title']} finished. Your adapter and samples are ready to download.")

    # ── Desktop agent ─────────────────────────────────────────────────────

    def agent_running(self, wid: int) -> bool:
        t = self._agents.get(wid)
        return bool(t and not t.done())

    def start_agent(self, w: dict, goal: str, runner: Callable[[dict, str, int], Awaitable[None]]) -> int:
        if self.agent_running(w["id"]):
            raise RuntimeError("The agent is already working on this desktop")
        run_id = new_id()
        self._agents[w["id"]] = asyncio.create_task(runner(w, goal, run_id), name=f"agent:{w['id']}")
        return run_id

    async def stop_agent(self, wid: int) -> None:
        if (t := self._agents.get(wid)) and not t.done():
            t.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t

    # ── Accounting & guard ────────────────────────────────────────────────

    def _segment(self, w: dict) -> tuple[datetime | None, int]:
        """Start and already-billed base of the current billing segment.

        The vault holds the precise values, but it is a local file. If it was lost
        (say, a redeploy without its volume), fall back to SpacetimeDB's `startedAt`,
        which the transition reducer sets whenever billing starts, so accrual and the
        session limit keep working instead of silently stopping.
        """
        v = self.vault.get(w["id"])
        if start := v.get("segment_start"):
            return datetime.fromisoformat(start), int(v.get("segment_base", 0))
        started = w.get("startedAt")
        if w["status"] in BILLABLE and isinstance(started, datetime):
            self.vault.update(w["id"], segment_start=started.isoformat(), segment_base=int(v.get("segment_base", 0)))
            return started, int(v.get("segment_base", 0))
        return None, 0

    def _accrued(self, w: dict) -> int:
        start, base = self._segment(w)
        if start is None or w["status"] not in BILLABLE:
            return int(w.get("accruedCents", 0))
        # Spend is monotonic: never report less than SpacetimeDB already recorded.
        return max(budget.accrued_cents(start, int(w["hourlyCents"]), base), int(w.get("accruedCents", 0)))

    async def _settle_usage(self, w: dict) -> None:
        cents = self._accrued(w)
        w["accruedCents"] = cents
        self.vault.update(w["id"], segment_start=None, segment_base=cents)
        await _safe(self.store.record_usage(w["id"], cents))

    def start_guard(self) -> None:
        if self._guard_task is None:
            self._guard_task = asyncio.create_task(self._guard_loop(), name="budget-guard")

    async def shutdown(self) -> None:
        if self._guard_task:
            self._guard_task.cancel()
        for t in self._monitors.values():
            t.cancel()
        await self.vnc.close_all()

    async def _guard_loop(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception as exc:
                log.warning("guard.tick_failed", error=str(exc))
            await asyncio.sleep(self.settings.budget_tick_seconds)

    async def tick(self) -> None:
        """One pass of accounting, guardrails and platform status."""
        workloads = await self.store.workloads()
        accounts = {a["identity"]: a for a in await self.store.accounts()}
        month = _now().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        limits = budget.PlatformLimits(self.settings.global_budget_cents, self.settings.max_concurrent_instances)

        live = [w for w in workloads if w["status"] in BILLABLE]
        for w in live:
            cents = self._accrued(w)
            if cents != w["accruedCents"]:
                await _safe(self.store.record_usage(w["id"], cents))
                w["accruedCents"] = cents

        platform_cents = sum(int(w["accruedCents"]) for w in workloads)
        per_account: dict[str, int] = {}
        for w in workloads:
            if w["createdAt"] >= month:
                per_account[w["owner"]] = per_account.get(w["owner"], 0) + int(w["accruedCents"])

        for w in live:
            if self.busy(w["id"]):
                continue
            acct = accounts.get(w["owner"], {})
            start, _ = self._segment(w)
            hours = (_now() - start).total_seconds() / 3600 if start else 0
            last = w.get("lastActiveAt")
            idle = (_now() - last).total_seconds() / 60 if last and not self.agent_running(w["id"]) else None
            action = budget.guard(
                workload_id=w["id"],
                kind=w["kind"],
                status=w["status"],
                accrued=int(w["accruedCents"]),
                est_high_cents=int(w["estHighCents"]),
                hours_running=hours,
                idle_minutes=idle,
                account_month_cents=per_account.get(w["owner"], 0),
                account_cap_cents=int(acct.get("monthlyCapCents", 0)) or 2000,
                platform_cents=platform_cents,
                limits=limits,
                max_session_hours=self.settings.max_session_hours,
                desktop_idle_minutes=self.settings.desktop_idle_minutes,
            )
            if action:
                log.info("guard.action", workload=w["id"], action=action.action, reason=action.reason)
                await self._event(w, f"{action.reason}. Stopping to protect your budget.", "warn")
                if action.action == "save_and_stop":
                    self.stop(w, action.reason)
                else:
                    self.terminate(w, action.reason)

        platform = (
            self.settings.provisioning_mode.value,
            self.settings.global_budget_cents,
            platform_cents,
            len(live),
            self.settings.max_concurrent_instances,
            json.dumps((self.integrations or self.settings.integrations)(), sort_keys=True),
        )
        # The platform row is public: every write fans out to every connected
        # browser, so only write when something actually changed.
        if platform != self._last_platform:
            try:
                await self.store.update_platform(*platform)
                self._last_platform = platform
            except Exception as exc:
                log.warning("supervisor.write_failed", error=str(exc))
        # Orphans are rare and the reconcile pass shells out to `brev ls`, so run it
        # every RECONCILE_SECONDS rather than on every 30 s budget tick.
        loop_now = asyncio.get_running_loop().time()
        if loop_now - self._last_reconcile >= RECONCILE_SECONDS:
            self._last_reconcile = loop_now
            await self.reconcile(workloads)

    async def reconcile(self, workloads: list[dict]) -> None:
        """Delete Anywhere instances that no billable workload owns."""
        if not self.brev.api_key or self.settings.provisioning_mode != ProvisioningMode.LIVE:
            return
        try:
            instances = await self.brev.list()
        except BrevError as exc:
            log.warning("reconcile.list_failed", error=str(exc))
            return
        # `workloads` was read at the start of the tick, before the (slow) Brev list,
        # so a launch may have created its machine in between. Count anything that
        # is approved, mid-operation, or has a vault entry as owned, and only delete
        # an instance that is still unowned on the next pass as well.
        owned = {
            instance_name(w["id"])
            for w in workloads
            if w["status"] in BILLABLE | {Status.STOPPED, Status.APPROVED} or self.busy(w["id"])
        }
        owned |= {instance_name(wid) for wid, t in self._tasks.items() if not t.done()}
        candidates = {
            inst.name
            for inst in instances
            if inst.name.startswith("anywhere-") and inst.name not in owned and inst.status != "DELETING"
        }
        confirmed = candidates & self._orphan_candidates
        self._orphan_candidates = candidates - confirmed
        if not confirmed:
            return
        fresh = {w["id"]: w for w in await self.store.workloads()}
        for name in sorted(confirmed):
            w = next((w for w in fresh.values() if instance_name(w["id"]) == name), None)
            if w and (w["status"] in BILLABLE | {Status.STOPPED, Status.APPROVED} or self.busy(w["id"])):
                continue
            log.warning("reconcile.orphan", instance=name)
            with contextlib.suppress(BrevError):
                await self.brev.delete(name)

    async def recover(self) -> None:
        """Reattach after a control-plane restart."""
        try:
            workloads = await self.store.workloads()
        except Exception as exc:
            log.warning("recover.unavailable", error=str(exc))
            return
        # ~/.ssh/config (which includes Brev's generated host aliases) does not
        # survive a container restart; regenerate it before touching machines.
        if self.brev.api_key and any(w["status"] in (Status.RUNNING, Status.SAVING) for w in workloads):
            try:
                await self.brev.refresh_ssh()
            except BrevError as exc:
                log.warning("recover.refresh_failed", error=str(exc))
        for w in workloads:
            status = w["status"]
            if status in (Status.PROVISIONING, Status.CONFIGURING, Status.SAVING, Status.STOPPING, Status.APPROVED):
                await self._fail(w, RuntimeError("Interrupted by a control-plane restart"))
            elif status == Status.RUNNING and w["kind"] == "batch":
                self._start_monitor(w)


# ── Batch polling protocol ──────────────────────────────────────────────────


@dataclass(frozen=True)
class Poll:
    #: False when the job directory is missing (machine reimaged or wiped).
    found: bool
    #: Byte offset in run.log up to which `log` was consumed.
    offset: int
    log: str
    metric_rows: list[str]
    status: str
    #: "yes", "no" (pid file but process gone), "starting" (no pid file yet), or ""
    #: when the output was unreadable.
    alive: str


def poll_command(log_offset: int, metric_lines: int, chunk: int = 12000) -> str:
    """One SSH round trip that returns new log bytes, complete new metric lines,
    the status file and whether the runner is alive, between unambiguous markers.

    The log bytes travel base64-encoded so `parse_poll` can cut them at a line
    boundary and count bytes exactly: a byte-sized cut could otherwise split a
    `::step::` marker or a multibyte character. printf, not `echo '\\n'`."""
    o, m = int(log_offset), int(metric_lines)
    return (
        f"cd {JOB_DIR} 2>/dev/null || {{ printf '::missing::\\n'; exit 0; }}; "
        f"size=$(wc -c < run.log 2>/dev/null || echo 0); end=$((size < {o + chunk} ? size : {o + chunk})); "
        f"[ $end -lt {o} ] && end={o}; "
        "printf '::log::'; "
        f"tail -c +{o + 1} run.log 2>/dev/null | head -c $((end - {o})) | base64 | tr -d '\\n'; "
        "printf '\\n::metrics::\\n'; "
        "total=$(cat metrics.jsonl 2>/dev/null | wc -l); "
        f"[ $total -gt {m} ] && tail -n +{m + 1} metrics.jsonl | head -n $((total - {m})); "
        "printf '::status::\\n'; cat status 2>/dev/null; "
        "printf '\\n::alive::\\n'; if [ -f pid ] && kill -0 \"$(cat pid)\" 2>/dev/null; then echo yes; "
        "elif [ -f pid ]; then echo no; else echo starting; fi"
    )


def parse_poll(out: str, log_offset: int = 0, chunk: int = 12000) -> Poll:
    """Parse `poll_command` output. `log_offset` is the offset the command read from."""
    if "::missing::" in out and "::log::" not in out:
        return Poll(False, log_offset, "", [], "", "")
    _, _, rest = out.partition("::log::")
    b64, _, rest = rest.partition("\n::metrics::\n")
    metrics_part, _, rest = rest.partition("::status::\n")
    status_part, _, alive_part = rest.partition("\n::alive::\n")
    status = status_part.strip()
    try:
        raw = base64.b64decode(b64.strip(), validate=True) if b64.strip() else b""
    except ValueError:
        raw = b""
    # Keep only complete lines unless the job has finished (then flush the tail),
    # or a single line is longer than a whole chunk (then take it as is).
    if raw and not raw.endswith(b"\n") and not status:
        cut = raw.rfind(b"\n")
        if cut >= 0:
            raw = raw[: cut + 1]
        elif len(raw) < chunk:
            raw = b""
    return Poll(
        found=True,
        offset=log_offset + len(raw),
        log=raw.decode("utf-8", errors="replace"),
        metric_rows=[ln for ln in metrics_part.split("\n") if ln.strip()],
        status=status,
        alive=alive_part.strip(),
    )


def metric_points(rows: list[str]) -> list[dict]:
    """Translate train.py's JSONL rows into `add_metrics` points."""
    points = []
    for line in rows:
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict):
            continue
        step = int(row.get("step", 0) or 0)
        for name in ("loss", "eval_loss", "learning_rate", "grad_norm"):
            value = row.get(name)
            if isinstance(value, int | float) and not isinstance(value, bool):
                points.append({"name": name, "step": step, "value": float(value)})
        if row.get("max_steps"):
            points.append({"name": "progress", "step": step, "value": step / max(int(row["max_steps"]), 1)})
    return points


@contextlib.contextmanager
def _script(content: str):
    with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as f:
        f.write(content)
    try:
        yield Path(f.name)
    finally:
        Path(f.name).unlink(missing_ok=True)


async def _until(check: Callable[[], Awaitable[bool]], *, timeout: float, what: str, interval: float = 8) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if await check():
            return
        await asyncio.sleep(interval)
    raise TimeoutError(f"Timed out waiting for {what}")


async def _safe(coro: Awaitable[Any]) -> None:
    try:
        await coro
    except Exception as exc:
        log.warning("supervisor.write_failed", error=str(exc))


def _now() -> datetime:
    return datetime.now(UTC)


__all__ = ["Supervisor", "StorageUnavailable", "render"]
