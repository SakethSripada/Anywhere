"""SSH access to provisioned instances.

`brev refresh` writes an SSH config whose host aliases are instance names, so
the control plane reaches machines without ever handling raw credentials or
exposing ports publicly. Commands sent here are composed by our own code from
vetted templates; model output never reaches a shell on this server.
"""

from __future__ import annotations

import asyncio
import contextlib
import shlex
import socket
import subprocess
from collections.abc import AsyncIterator
from dataclasses import dataclass

SSH_OPTS = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ServerAliveInterval=20",
    "-o",
    "ServerAliveCountMax=3",
]

#: Commands share one SSH connection per host, so the frequent short polls (log
#: tails, reachability, job status) skip a full handshake each time. `%C` keeps
#: the socket path short and unique per host/user.
MUX_OPTS = [
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPath=/tmp/anywhere-ssh-%C",
    "-o",
    "ControlPersist=5m",
]

#: Port forwards must not ride a shared master: a forward requested through a mux
#: client lives in the master and outlives the client, so closing it would leak.
NO_MUX_OPTS = ["-o", "ControlMaster=no", "-o", "ControlPath=none"]


class RemoteError(Exception):
    pass


@dataclass(frozen=True)
class Result:
    code: int
    stdout: str
    stderr: str


class Remote:
    def __init__(self, host: str):
        self.host = host

    def _argv(self, command: str) -> list[str]:
        return ["ssh", *SSH_OPTS, *MUX_OPTS, self.host, "--", command]

    async def run(
        self, command: str, *, timeout: float = 120, input: bytes | None = None, check: bool = True
    ) -> Result:
        proc = await asyncio.create_subprocess_exec(
            *self._argv(command),
            stdin=asyncio.subprocess.PIPE if input is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(input), timeout)
        except (TimeoutError, asyncio.CancelledError) as exc:
            proc.kill()
            await proc.wait()
            if isinstance(exc, asyncio.CancelledError):
                raise
            raise RemoteError(f"Remote command timed out after {timeout:.0f}s") from exc
        result = Result(proc.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace"))
        if check and result.code != 0:
            raise RemoteError(f"Remote command exited {result.code}: {result.stderr.strip()[-600:]}")
        return result

    async def write_file(self, path: str, content: bytes, mode: str = "0644") -> None:
        q = shlex.quote(path)
        await self.run(f"mkdir -p $(dirname {q}) && cat > {q} && chmod {mode} {q}", input=content)

    async def reachable(self) -> bool:
        try:
            return (await self.run("true", timeout=25, check=False)).code == 0
        except RemoteError:
            return False

    def popen(self, command: str, *, stdin: int | None = None, stdout: int | None = None) -> subprocess.Popen:
        """Blocking process handle for streaming large tarballs to/from object storage."""
        return subprocess.Popen(self._argv(command), stdin=stdin, stdout=stdout, stderr=subprocess.PIPE)

    @contextlib.asynccontextmanager
    async def tunnel(self, remote_port: int) -> AsyncIterator[int]:
        """Forward a free local port to `remote_port` on the instance's loopback."""
        local_port = _free_port()
        proc = await asyncio.create_subprocess_exec(
            "ssh",
            *SSH_OPTS,
            *NO_MUX_OPTS,
            "-o",
            "ExitOnForwardFailure=yes",
            "-N",
            "-L",
            f"127.0.0.1:{local_port}:127.0.0.1:{remote_port}",
            self.host,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            await _wait_port(local_port, proc)
            yield local_port
        finally:
            if proc.returncode is None:
                proc.terminate()
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(proc.wait(), 5)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def _wait_port(port: int, proc: asyncio.subprocess.Process, timeout: float = 20) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if proc.returncode is not None:
            err = (await proc.stderr.read()).decode(errors="replace") if proc.stderr else ""
            raise RemoteError(f"SSH tunnel exited: {err.strip()[-400:]}")
        try:
            _, writer = await asyncio.open_connection("127.0.0.1", port)
            writer.close()
            return
        except OSError:
            await asyncio.sleep(0.25)
    raise RemoteError("SSH tunnel did not come up")
