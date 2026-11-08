"""Fast path for "build / render X in Blender": the judge-demo loop.

One text-model call writes a short script against the `kit` helpers that
environments/blender-autosave.py preloads into Blender, the script runs inside the
open Blender window (so it appears live in the stream), a traceback gets one
automatic fix, and a GPU still is rendered and sent back (chat + linked phones).
No screenshot-by-screenshot loop: that path took minutes and drifted.
"""

from __future__ import annotations

import asyncio
import base64
import re
import time
from typing import TYPE_CHECKING

import structlog
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_nvidia_ai_endpoints import ChatNVIDIA

from .desktop import connect_screen
from .llm import _key
from .operator import run_in_blender

if TYPE_CHECKING:
    from .config import Settings
    from .core import Anywhere

log = structlog.get_logger()

RENDER_PATH = "/tmp/anywhere-render.jpg"

SCENE_PROMPT = """You write ONE Python script that builds a 3D scene inside a running Blender 4.5.
It runs inside Blender with `bpy`, `math`, `random`, `mathutils`, `bmesh` and `kit` already available.
Reply with ONLY the code. No markdown fences, no explanation.

Use the kit helpers (they're tested and forgiving). Colours can be (r, g, b) in 0-1, "#rrggbb", or
names like "cyan", "magenta", "gold". Every builder returns the object(s) it made.
- kit.clear()  empty the scene. Always call first.
- kit.material(name, color, metallic=0, roughness=0.5, emission=None, strength=0)  emission=color or True
  makes it glow; strength 5-30 for neon.
- kit.sky(time="day"|"noon"|"golden"|"sunset"|"sunrise"|"dusk"|"night")  physical sky AND matching sun.
  Use it for any outdoor scene (it lights the scene; don't add another kit.sun).
- kit.world(color, strength)  plain studio background. kit.starry_sky()  stars only (space).
- kit.ground(size=400, color, grid=None)  floor at z=0; grid="magenta" adds glowing grid lines.
- kit.water(size, color, z=0)  glossy sea or lake.
- kit.terrain(size=120, height=10, color, seed=0, snow=False)  hills or mountains around a flat centre at
  z=0 (radius size/8) where the subject goes; returns the object.
- kit.trees(count=60, area=50, height=4, leaves=color, ground=terrain_obj)  low-poly forest.
- kit.city(blocks=8, spacing=7, max_height=45, palette="neon" or "warm", seed=0)  a whole lit city.
- kit.rocket(location, height=14, color, accent, launching=True)  rocket with flame, light and smoke.
- kit.planet(name, location, radius, color, rings=False, glow=False)  planets; glow=True makes a star.
- kit.box(name, location, size, material)  box standing on location, size (sx, sy, sz).
- kit.sphere(name, location, radius, material)  centred on location.
- kit.cylinder(name, location, radius, height, material) and kit.cone(...)  standing on location.
- kit.torus(name, location, radius, thickness, material, rotation=(rx, ry, rz))  rings, halos, portals.
- kit.text(body, location, size, material)  3D lettering standing up.
- kit.windows(name, glow=color, strength=8, lit=0.4)  material: facade with lit windows (use on kit.box).
- kit.sun(name, rotation, color, energy)  daylight ~3-5, moonlight ~0.5-1.
- kit.light(name, location, color, energy=1000, kind="POINT"|"AREA"|"SPOT")  lamps, glowing accents.
- kit.orbit_camera(subject=hero_objects)  camera that frames the hero object(s) and circles them. Always
  pass subject= the main thing that was asked for (a list of its parts is fine), never the whole scene.
- kit.glow()  bloom (use whenever anything emits light).
- kit.show()  live GPU ray-traced view through the camera. kit.save()  save.

Rules:
- Build something striking and recognisable for the request in under 60 lines. Compose kit
  builders; build a hero object from primitives (boxes, spheres, cylinders, cones, tori) arranged
  with math when there's no builder for it (a rocket = cylinder + cone + fins, a robot = boxes).
- Match the request's time of day and mood with kit.sky; space scenes use kit.starry_sky(). Every
  object gets a material with a deliberate colour; add a few emissive accents and kit.glow().
- The subject must be big and centred at the origin on z=0, with a ground (kit.ground, kit.terrain or
  kit.water) unless it's in space.
- Colour contrast: the subject's colours must differ clearly from the ground and sky (stone castle on
  green hills, red car on dark asphalt). Use 3-5 colours, not one.
- Add the details that make it recognisable: roofs and spires on towers (kit.cone), windows that glow
  (emissive boxes), wheels on vehicles (kit.cylinder rotated 90 degrees), flags, lamps, trees around.
- Keep it under ~800 objects. No bpy.ops except what kit does. No file or network access.
- Keep the objects that make up the subject in a list (hero = [...]) and pass it to kit.orbit_camera.
- End with exactly: kit.orbit_camera(...), kit.glow() if anything glows, kit.show(), kit.save()

Example for "a neon city at night":
kit.clear()
kit.sky(time="night")
kit.ground(color="black", grid="magenta")
kit.city(blocks=9, palette="neon", seed=4)
sign = kit.material("Sign", "cyan", emission="cyan", strength=20)
kit.text("ANYWHERE", location=(-38, 0, 2), size=6, material=sign)
kit.orbit_camera(target=(0, 0, 10), radius=75, height=32)
kit.glow()
kit.show()
kit.save()

Example for "a rocket launching from a desert at sunset":
kit.clear()
kit.sky(time="sunset")
land = kit.terrain(size=300, height=6, color=(0.75, 0.45, 0.22), seed=2)
hero = kit.rocket(location=(0, 0, 0), height=18, color="white", accent="red")
pad = kit.material("Pad", (0.2, 0.2, 0.22), metallic=0.6)
kit.cylinder("Pad", (0, 0, 0), radius=6, height=1.5, material=pad)
for i, x in enumerate((-40, 35, 60)):
    kit.cone(f"Mesa{i}", (x, 70, 0), radius=14, height=18, material=kit.material(f"Rock{i}", (0.55, 0.28, 0.14)))
kit.orbit_camera(subject=hero)
kit.glow()
kit.show()
kit.save()
"""

_FENCE = re.compile(r"```(?:python|py)?\s*\n(.*?)```", re.S)
_THINK = re.compile(r"<think>.*?</think>", re.S)


def coder(settings: Settings) -> ChatNVIDIA:
    """The planner model with reasoning off: writing a short kit script doesn't need it,
    and reasoning tokens were most of the latency."""
    model = ChatNVIDIA(
        model=settings.planner_model,
        api_key=_key(settings),
        base_url=settings.nvidia_base_url,
        temperature=0.6,
        top_p=0.95,
        max_completion_tokens=4096,
    )
    known = model._client.model
    if known is not None and known.supports_thinking:
        return model.with_thinking_mode(enabled=False)
    return model


def extract_code(text: str) -> str:
    """The script from a model reply: drops reasoning, fences and stray prose."""
    text = _THINK.sub("", text or "").strip()
    if m := _FENCE.search(text):
        return m.group(1).strip()
    return text.removeprefix("```python").removeprefix("```").removesuffix("```").strip()


async def write_script(settings: Settings, request: str, previous: str = "", error: str = "") -> str:
    messages = [SystemMessage(SCENE_PROMPT), HumanMessage(f"Build this: {request}")]
    if error:
        messages.append(
            HumanMessage(
                f"Your script:\n{previous}\n\nfailed with:\n{error[-1500:]}\n\n"
                "Reply with the whole corrected script only."
            )
        )
    reply = await coder(settings).ainvoke(messages)
    content = reply.content if isinstance(reply.content, str) else str(reply.content)
    return extract_code(content)


async def build(app: Anywhere, w: dict, request: str) -> None:
    """Build `request` in the desktop's Blender, render a still, and send it back."""
    wid = int(w["id"])
    started = time.monotonic()
    try:
        remote = app.supervisor.remote(w)
        async with connect_screen(remote, app.vault.agent_token(wid)) as screen:
            code = await write_script(app.settings, request)
            outcome = await run_in_blender(screen, code)
            if not outcome.startswith("ok"):
                log.info("scene.retry", workload=wid, error=outcome[-300:])
                code = await write_script(app.settings, request, previous=code, error=outcome)
                outcome = await run_in_blender(screen, code)
            if not outcome.startswith("ok"):
                await app.notify(w, "error", f"I couldn't build that one: {outcome.splitlines()[-1][:200]}")
                return
            built = time.monotonic() - started
            await app.notify(w, "status", f"Built it live in {built:.0f}s. Rendering a picture on the GPU…")
            rendered = await run_in_blender(screen, f"kit.render_still(path={RENDER_PATH!r}, samples=24)\nkit.show()")
            if not rendered.startswith("ok"):
                await app.notify(w, "status", "It's built and on screen. The picture render didn't finish.")
                return
            _, b64 = await screen.shell(f"base64 -w0 {RENDER_PATH}", timeout=30)
        jpeg = base64.b64decode(b64.strip())
        key = f"renders/{w['owner']}/{wid}/{int(time.time())}.jpg"
        await app.storage.put_bytes(key, jpeg, "image/jpeg")
        total = time.monotonic() - started
        await app.notify(
            w, "status", f"Here's {request.strip().rstrip('.')}, rendered on the T4 ({total:.0f}s total).", key
        )
        log.info("scene.done", workload=wid, seconds=round(total, 1))
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        log.exception("scene.failed", workload=wid)
        await app.notify(w, "error", f"I couldn't build that one: {str(exc)[:200]}")
