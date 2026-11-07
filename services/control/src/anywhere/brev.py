"""NVIDIA Brev provider.

Brev documents no public REST API; the supported automation surface is the
`brev` CLI authenticated with an org-scoped API key (BREV_API_KEY). We invoke
it with argument vectors (never a shell), parse its `--json` output, and keep
every call bounded by a timeout.

JSON shapes come from brev-cli v0.6.337: `brev ls --json` emits WorkspaceInfo
rows; `brev search gpu --json` emits GPUInstanceInfo rows.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
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
    def __init__(self, binary: str, api_key: str | None, mode: ProvisioningMode):
        self.binary = binary
        self.api_key = api_key
        self.mode = mode

    async def _run(self, *args: str, timeout: float = 120) -> str:
        env = {**os.environ, "BREV_API_KEY": self.api_key or ""}
        try:
            proc = await asyncio.create_subprocess_exec(
                self.binary,
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
        except FileNotFoundError as exc:
            raise BrevError(f"Brev CLI not found at '{self.binary}'") from exc
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout)
        except TimeoutError as exc:
            proc.kill()
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
        out = await self._run("ls", "--json", timeout=45)
        data = json.loads(out or "[]")
        if isinstance(data, dict):
            data = data.get("workspaces") or data.get("instances") or []
        return [Instance.from_json(r) for r in data]

    async def get(self, name: str) -> Instance | None:
        return next((i for i in await self.list() if i.name == name), None)

    async def refresh_ssh(self) -> None:
        await self._run("refresh", timeout=60)

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
            "--startup-script",
            f"@{startup_script}",
            "--detached",
        ]
        dry_run = self.mode == ProvisioningMode.DRY_RUN
        if dry_run:
            args.append("--dry-run")
        log.info("brev.create", name=name, type=instance_type, dry_run=dry_run)
        out = await self._run(*args, timeout=300)
        return CreateResult(name=name, dry_run=dry_run, output=out.strip()[-2000:])

    async def stop(self, name: str) -> None:
        self._guard()
        await self._run("stop", name, timeout=180)

    async def start(self, name: str) -> None:
        self._guard()
        await self._run("start", name, timeout=300)

    async def delete(self, name: str) -> None:
        # Deleting is always allowed when a key exists: cleanup must never be blocked.
        if not self.api_key:
            raise ProvisioningDisabled("BREV_API_KEY is not configured")
        await self._run("delete", name, timeout=180)

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


def instance_name(workload_id: int) -> str:
    return f"anywhere-{workload_id:x}"
