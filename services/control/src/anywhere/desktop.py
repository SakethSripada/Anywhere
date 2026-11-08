"""Live connections to a running desktop: the VNC stream for the browser and the
Cua sandbox for the agent, both over SSH tunnels to the instance's loopback."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import io
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol

from PIL import Image

from .remote import Remote

VNC_PORT = 6080
#: A second, view-only VNC server (x11vnc -viewonly) for watch links.
WATCH_VNC_PORT = 6081
SPACESD_PORT = 3211


class Screen(Protocol):
    """The operations the operator needs; implemented by Cua (and fakes in tests)."""

    async def screenshot(self) -> bytes: ...
    async def size(self) -> tuple[int, int]: ...
    async def click(self, x: int, y: int, button: str = "left", double: bool = False) -> None: ...
    async def move(self, x: int, y: int) -> None: ...
    async def drag(self, x1: int, y1: int, x2: int, y2: int) -> None: ...
    async def scroll(self, x: int, y: int, dy: int) -> None: ...
    async def type(self, text: str) -> None: ...
    async def keys(self, keys: list[str]) -> None: ...
    async def shell(self, command: str, timeout: float = 60) -> tuple[int, str]: ...


class CuaScreen:
    """Adapter over `cua_sandbox.Sandbox` (cua-spacesd gRPC).

    Verified against ghcr.io/trycua/linux:24.04 (cua-spacesd 0.12.7) with
    cua-sandbox 0.9.1 + cua 0.5.0: 1280x800 PNG screenshots, mouse/keyboard
    input, and shell commands, which run as the image's `cua` user."""

    def __init__(self, sandbox):
        self.sb = sandbox

    async def screenshot(self) -> bytes:
        return await self.sb.screenshot()

    async def size(self) -> tuple[int, int]:
        w, h = await self.sb.get_dimensions()
        return int(w), int(h)

    async def click(self, x: int, y: int, button: str = "left", double: bool = False) -> None:
        if double:
            await self.sb.mouse.double_click(x, y)
        elif button == "right":
            await self.sb.mouse.right_click(x, y)
        else:
            await self.sb.mouse.click(x, y, button="left")

    async def move(self, x: int, y: int) -> None:
        await self.sb.mouse.move(x, y)

    async def drag(self, x1: int, y1: int, x2: int, y2: int) -> None:
        await self.sb.mouse.drag(x1, y1, x2, y2, button="left")

    async def scroll(self, x: int, y: int, dy: int) -> None:
        await self.sb.mouse.scroll(x, y, scroll_x=0, scroll_y=dy)

    async def type(self, text: str) -> None:
        await self.sb.keyboard.type(text)

    async def keys(self, keys: list[str]) -> None:
        await self.sb.keyboard.keypress(keys if len(keys) > 1 else keys[0])

    async def shell(self, command: str, timeout: float = 60) -> tuple[int, str]:
        r = await self.sb.shell.run(command, timeout=int(timeout))
        out = (getattr(r, "stdout", "") or "") + (getattr(r, "stderr", "") or "")
        return int(getattr(r, "returncode", 0) or 0), out


@dataclass
class Frame:
    """A screenshot prepared for the vision model, with the mapping back to screen pixels."""

    jpeg: bytes
    width: int
    height: int
    scale: float  # screen px per image px

    @property
    def data_url(self) -> str:
        return "data:image/jpeg;base64," + base64.b64encode(self.jpeg).decode()

    def to_screen(self, x: float, y: float) -> tuple[int, int]:
        return round(x * self.scale), round(y * self.scale)


def prepare_frame(png: bytes, max_width: int = 1280, quality: int = 72) -> Frame:
    """Downscale and JPEG-compress so screenshots stay well under inline image limits."""
    img = Image.open(io.BytesIO(png)).convert("RGB")
    scale = 1.0
    if img.width > max_width:
        scale = img.width / max_width
        img = img.resize((max_width, round(img.height / scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True)
    return Frame(jpeg=buf.getvalue(), width=img.width, height=img.height, scale=scale)


@contextlib.asynccontextmanager
async def connect_screen(remote: Remote, token: str, *, port: int | None = None) -> AsyncIterator[Screen]:
    """Connect to the desktop's Cua server, through a fresh tunnel or an existing
    local `port` (see `Screenshots`)."""
    # The native Cua runtime has its own telemetry, separate from `telemetry_enabled`.
    os.environ.setdefault("CUA_TELEMETRY", "0")
    try:
        from cua_sandbox import Sandbox
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise RuntimeError("cua-sandbox is not installed") from exc
    async with contextlib.AsyncExitStack() as stack:
        if port is None:
            port = await stack.enter_async_context(remote.tunnel(SPACESD_PORT))
        sb = await stack.enter_async_context(
            Sandbox.connect(url=f"http://127.0.0.1:{port}", token=token, telemetry_enabled=False)
        )
        yield CuaScreen(sb)


async def _accepts(port: int) -> bool:
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", port), 3)
    except (OSError, TimeoutError):
        return False
    writer.close()
    return True


class TunnelPool:
    """One shared SSH tunnel per desktop to a port on its loopback.

    Each workload has its own lock, so a slow or dead desktop (probing takes up
    to 3 s, bringing a tunnel up up to 20 s) never blocks other users' connects."""

    def __init__(self, remote_port: int = VNC_PORT) -> None:
        self.remote_port = remote_port
        self._tunnels: dict[int, tuple[contextlib.AbstractAsyncContextManager, int]] = {}
        self._locks: dict[int, asyncio.Lock] = {}

    def _lock(self, workload_id: int) -> asyncio.Lock:
        return self._locks.setdefault(workload_id, asyncio.Lock())

    async def port_for(self, workload_id: int, remote: Remote) -> int:
        async with self._lock(workload_id):
            if workload_id in self._tunnels:
                cm, port = self._tunnels[workload_id]
                if await _accepts(port):
                    return port
                # The SSH process died (machine stopped, network blip): rebuild it.
                del self._tunnels[workload_id]
                with contextlib.suppress(Exception):
                    await cm.__aexit__(None, None, None)
            cm = remote.tunnel(self.remote_port)
            port = await cm.__aenter__()
            self._tunnels[workload_id] = (cm, port)
            return port

    async def close(self, workload_id: int) -> None:
        async with self._lock(workload_id):
            entry = self._tunnels.pop(workload_id, None)
        self._locks.pop(workload_id, None)
        if entry:
            await entry[0].__aexit__(None, None, None)

    async def close_all(self) -> None:
        for wid in list(self._tunnels):
            await self.close(wid)


class VncTunnels(TunnelPool):
    """Browser VNC sessions: one shared tunnel per desktop to its VNC port, and one to
    its view-only port for people watching through a share link."""

    def __init__(self) -> None:
        super().__init__(VNC_PORT)
        self.watch = TunnelPool(WATCH_VNC_PORT)

    async def close(self, workload_id: int) -> None:
        await super().close(workload_id)
        await self.watch.close(workload_id)

    async def close_all(self) -> None:
        await super().close_all()
        await self.watch.close_all()


class Screenshots:
    """Live screenshots for API/MCP callers, without a new SSH handshake and Cua
    connection per call: the tunnel to the desktop's Cua port is pooled, a frame
    is reused for `ttl` seconds, and concurrent callers share one capture."""

    def __init__(self, ttl: float = 3.0) -> None:
        self.ttl = ttl
        self.tunnels = TunnelPool(SPACESD_PORT)
        self._cache: dict[int, tuple[float, Frame]] = {}
        self._inflight: dict[int, asyncio.Task] = {}

    async def frame(self, workload_id: int, remote: Remote, token: str, timeout: float = 20) -> Frame:
        now = asyncio.get_running_loop().time()
        if (hit := self._cache.get(workload_id)) and now - hit[0] < self.ttl:
            return hit[1]
        task = self._inflight.get(workload_id)
        if task is None or task.done():
            task = asyncio.create_task(self._capture(workload_id, remote, token, timeout))
            self._inflight[workload_id] = task
        return await asyncio.shield(task)

    async def _capture(self, workload_id: int, remote: Remote, token: str, timeout: float) -> Frame:
        try:
            port = await self.tunnels.port_for(workload_id, remote)
            async with connect_screen(remote, token, port=port) as screen:
                png = await asyncio.wait_for(screen.screenshot(), timeout)
            frame = await asyncio.to_thread(prepare_frame, png)
            self._cache[workload_id] = (asyncio.get_running_loop().time(), frame)
            return frame
        finally:
            self._inflight.pop(workload_id, None)

    async def close(self, workload_id: int) -> None:
        self._cache.pop(workload_id, None)
        await self.tunnels.close(workload_id)

    async def close_all(self) -> None:
        self._cache.clear()
        await self.tunnels.close_all()
