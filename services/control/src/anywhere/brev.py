"""NVIDIA Brev provider.

Brev documents no public REST API; the supported automation surface is the
`brev` CLI authenticated with an org-scoped API key. We invoke it with argument
vectors (never a shell), parse its `--json` output, and keep every call bounded
by a timeout.

Verified against brev-cli v0.6.337 (source and `--help`):
  * Auth: the CLI reads `BREV_API_KEY` (keys start with `bak-`) from the
    environment on every command, so no `brev login` is needed. Without any
    credential, commands print an interactive "log in? [Y/n]" prompt and may
    exit 0, so stdin is closed and non-JSON output is treated as an error.
  * `brev ls --json` prints `{"workspaces": [WorkspaceInfo] | null}`.
  * `brev search gpu --json` prints `[GPUInstanceInfo]` and needs no auth.
  * `brev create NAME --type T --dry-run` only echoes the type locally; it
    neither authenticates nor checks the type, so dry-run mode validates both
    explicitly (see `validate`).
  * `brev start` blocks while polling unless `--detached` is passed.
  * `brev refresh` writes ~/.brev/ssh_config with one `Host <name>` alias per
    running instance (and `<name>-host`); in VM mode both reach the VM.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path

import structlog

from .config import ProvisioningMode

log = structlog.get_logger()

NAME_RE = re.compile(r"^[a-z][a-z0-9-]{2,40}$")


class BrevError(Exception):
    pass


class ProvisioningDisabled(BrevError):
    pass


@dataclass(frozen=True)
class Instance:
    name: str
    id: str
    status: str  # RUNNING | STARTING | STOPPING | DEPLOYING | STOPPED | DELETING | FAILURE
    shell_status: str
    health_status: str
    instance_type: str

    @property
    def running(self) -> bool:
        return self.status == "RUNNING"

    @property
    def ready(self) -> bool:
        return self.running and self.shell_status.upper() in ("READY", "")

    @classmethod
    def from_json(cls, row: dict) -> Instance:
        return cls(
            name=row.get("name", ""),
            id=row.get("id", ""),
            status=(row.get("status") or "").upper(),
            shell_status=(row.get("shell_status") or "").upper(),
            health_status=(row.get("health_status") or "").upper(),
            instance_type=row.get("instance_type", ""),
        )


@dataclass(frozen=True)
class CreateResult:
    name: str
    dry_run: bool
    output: str


class BrevCLI:
    #: How long one `brev ls` result is shared. Boot/stop waits, deletes and the
    #: reconciler all read the list; within this window they reuse a single call.
    LIST_TTL_SECONDS = 8.0

    def __init__(self, binary: str, api_key: str | None, mode: ProvisioningMode):
        self.binary = binary
        self.api_key = api_key
        self.mode = mode
        self._list_cache: tuple[float, list[Instance]] | None = None
        self._list_inflight: asyncio.Task | None = None
        self._generation = 0

    def _invalidate(self) -> None:
        self._generation += 1
        self._list_cache = None
        self._list_inflight = None

    async def _run(self, *args: str, timeout: float = 120) -> str:
        env = dict(os.environ)
        if self.api_key:
            env["BREV_API_KEY"] = self.api_key
        try:
            proc = await asyncio.create_subprocess_exec(
                self.binary,
                *args,
                # Never let the CLI block on an interactive login prompt.
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
        except FileNotFoundError as exc:
            raise BrevError(f"Brev CLI not found at '{self.binary}'") from exc
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout)
        except (TimeoutError, asyncio.CancelledError) as exc:
            # Reap the child so timeouts and cancelled callers don't leave zombies behind.
            proc.kill()
            await proc.wait()
            if isinstance(exc, asyncio.CancelledError):
                raise
            raise BrevError(f"brev {args[0]} timed out after {timeout:.0f}s") from exc
        if proc.returncode != 0:
            message = (err or out).decode(errors="replace").strip()[-800:]
            raise BrevError(f"brev {args[0]} failed: {message}")
        return out.decode(errors="replace")

    # ── Read-only ─────────────────────────────────────────────────────────

    async def search_gpu_json(self) -> str:
        """Live instance-type pricing. Works without authentication."""
        return await self._run("search", "gpu", "--json", timeout=45)

    async def list(self) -> list[Instance]:
        """`brev ls`, shared: concurrent callers join one subprocess and reuse its
        result for LIST_TTL_SECONDS. Any mutation invalidates the cache."""
        if self._list_cache and time.monotonic() - self._list_cache[0] < self.LIST_TTL_SECONDS:
            return list(self._list_cache[1])
        if self._list_inflight is None or self._list_inflight.done():
            self._list_inflight = asyncio.create_task(self._list_uncached())
        return list(await asyncio.shield(self._list_inflight))

    async def _list_uncached(self) -> list[Instance]:
        generation = self._generation
        out = await self._run("ls", "--json", timeout=45)
        rows = [Instance.from_json(r) for r in parse_ls(out)]
        if generation == self._generation:  # a mutation since the call started makes it stale
            self._list_cache = (time.monotonic(), rows)
        return rows

    async def get(self, name: str) -> Instance | None:
        return next((i for i in await self.list() if i.name == name), None)

    async def refresh_ssh(self) -> None:
        await self._run("refresh", timeout=90)

    async def check_auth(self) -> int:
        """Confirm the CLI is authenticated. Returns how many instances the org has."""
        return len(await self.list())

    async def validate(self, instance_type: str) -> None:
        """What a dry run proves: credentials work and Brev offers this type right now."""
        await self.check_auth()
        try:
            rows = json.loads(await self.search_gpu_json())
        except json.JSONDecodeError as exc:
            raise BrevError("brev search returned unexpected output") from exc
        if isinstance(rows, list) and not any(r.get("type") == instance_type for r in rows if isinstance(r, dict)):
            raise BrevError(f"Brev does not currently offer instance type {instance_type}")

    # ── Mutations ─────────────────────────────────────────────────────────

    def _guard(self) -> None:
        if not self.api_key:
            raise ProvisioningDisabled("BREV_API_KEY is not configured")
        if self.mode == ProvisioningMode.DISABLED:
            raise ProvisioningDisabled("Provisioning is disabled (PROVISIONING_MODE=disabled)")

    async def create(self, name: str, instance_type: str, startup_script: Path) -> CreateResult:
        self._guard()
        if not NAME_RE.match(name):
            raise BrevError(f"Invalid instance name: {name!r}")
        args = [
            "create",
            name,
            "--type",
            instance_type,
            "--mode",
            "vm",
            "--jupyter=false",
            "--startup-script",
            f"@{startup_script}",
            "--detached",
        ]
        dry_run = self.mode == ProvisioningMode.DRY_RUN
        if dry_run:
            # `create --dry-run` is local-only; check auth and the type first.
            await self.validate(instance_type)
            args.append("--dry-run")
        log.info("brev.create", name=name, type=instance_type, dry_run=dry_run)
        try:
            out = await self._run(*args, timeout=300)
        finally:
            self._invalidate()
        return CreateResult(name=name, dry_run=dry_run, output=out.strip()[-2000:])

    async def stop(self, name: str) -> None:
        self._guard()
        try:
            await self._run("stop", name, timeout=180)
        finally:
            self._invalidate()

    async def start(self, name: str) -> None:
        self._guard()
        try:
            await self._run("start", name, "--detached", timeout=300)
        finally:
            self._invalidate()

    async def delete(self, name: str) -> None:
        # Deleting is always allowed when a key exists: cleanup must never be blocked.
        if not self.api_key:
            raise ProvisioningDisabled("BREV_API_KEY is not configured")
        try:
            await self._run("delete", name, timeout=180)
        finally:
            self._invalidate()

    async def wait_for(
        self, name: str, *, want: str = "RUNNING", timeout: float = 1200, interval: float = 10
    ) -> Instance:
        """Poll `brev ls` until the instance reaches a status. `brev create` may
        return before the machine exists, so this is the source of truth."""
        deadline = asyncio.get_running_loop().time() + timeout
        last: Instance | None = None
        while asyncio.get_running_loop().time() < deadline:
            last = await self.get(name)
            if last and last.status == want and (want != "RUNNING" or last.ready):
                return last
            if last and last.status == "FAILURE":
                raise BrevError(f"Instance {name} failed to deploy")
            await asyncio.sleep(interval)
        raise BrevError(f"Instance {name} did not reach {want} within {timeout / 60:.0f} min (last: {last})")


def parse_ls(out: str) -> list[dict]:
    """Rows from `brev ls --json`; anything that isn't JSON means the CLI isn't authenticated."""
    try:
        data = json.loads(out or "{}")
    except json.JSONDecodeError as exc:
        hint = out.strip().splitlines()[0][:200] if out.strip() else "no output"
        raise BrevError(f"brev ls did not return JSON (is BREV_API_KEY set and valid?): {hint}") from exc
    if isinstance(data, dict):
        data = data.get("workspaces") or []
    if not isinstance(data, list):
        raise BrevError("brev ls returned an unexpected shape")
    return [r for r in data if isinstance(r, dict)]


def instance_name(workload_id: int) -> str:
    return f"anywhere-{workload_id:x}"
