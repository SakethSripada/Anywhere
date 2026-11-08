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
import json
import re
import secrets
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
- kit.orbit_camera(subject=hero_objects)  camera that frames the hero object(s) and circles them. Pass
  subject= the main thing that was asked for (a list of its parts is fine); with no subject it frames
  everything except ground, water and terrain. Don't pass target/radius.
- kit.glow()  bloom (use whenever anything emits light).
- kit.show()  live GPU ray-traced view through the camera. kit.save()  save.

Rules:
- If a builder exists for the subject, you MUST use it, never rebuild it from primitives:
  rockets -> kit.rocket, cities/skylines -> kit.city, planets/stars/space -> kit.planet + kit.starry_sky,
  hills/mountains/landscapes -> kit.terrain, forests -> kit.trees, seas/lakes -> kit.water.
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
- Stacking: box, cylinder and cone stand ON their location (base at z), spheres and tori are centred.
  Put each part's base exactly on the previous part's top, e.g. a tower: kit.cylinder(z=0, height=20),
  then kit.cylinder("Top", (0, 0, 20), radius=3, height=4), then kit.cone("Roof", (0, 0, 24), ...).
  Never leave gaps or float parts, and cones point up (don't rotate them unless asked).
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


SUBJECT_PROMPT = """Decide whether this 3D render request has ONE main subject that a text-to-3D model should
generate (an object, vehicle, creature, character, building or product). Reply with ONLY JSON:
{"object": "<the subject in under 12 words, with its key colours and materials>", "height": <its real height in metres>}
or {"object": ""} when the request is a landscape, a city, space, abstract art, text, or a whole scene with no single subject.
Examples: "a pirate ship on the ocean at sunset" -> {"object": "a wooden pirate ship with black sails and cannons", "height": 14}
"a neon city at night" -> {"object": ""}"""


async def pick_subject(settings: Settings, request: str) -> tuple[str, float] | None:
    reply = await coder(settings).ainvoke([SystemMessage(SUBJECT_PROMPT), HumanMessage(request)])
    text = _THINK.sub("", reply.content if isinstance(reply.content, str) else str(reply.content))
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except ValueError:
        return None
    obj = str(data.get("object") or "").strip()
    if not obj:
        return None
    try:
        height = float(data.get("height") or 6)
    except (TypeError, ValueError):
        height = 6.0
    return obj, max(0.5, min(height, 120.0))


async def gen3d(settings: Settings, prompt: str) -> bytes | None:
    """A textured mesh of `prompt` from the GPU box's gen3d server, or None."""
    if not settings.gen3d_host:
        return None
    from .remote import Remote

    cmd = (
        "curl -sf -m 100 -X POST http://127.0.0.1:7860/generate -H 'Content-Type: application/json' "
        "--data-binary @- | base64 -w0"
    )
    try:
        res = await Remote(settings.gen3d_host).run(cmd, input=json.dumps({"prompt": prompt}).encode(), timeout=120)
        glb = base64.b64decode(res.stdout.strip())
        return glb if glb[:4] == b"glTF" else None
    except Exception as exc:
        log.warning("scene.gen3d_failed", error=str(exc)[:200])
        return None


async def write_script(
    settings: Settings, request: str, previous: str = "", error: str = "", hero: tuple[str, float] | None = None
) -> str:
    messages = [SystemMessage(SCENE_PROMPT), HumanMessage(f"Build this: {request}")]
    if hero:
        messages.append(
            HumanMessage(
                f"A detailed, textured 3D model of '{hero[0]}' is being generated for you. Place it with "
                f"hero = kit.hero(height={hero[1]:g}, location=(0, 0, 0)) and build only the setting around it "
                "(sky, ground or water, a few props, lighting). Do NOT build the subject from primitives. "
                "Pass subject=hero to kit.orbit_camera."
            )
        )
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


MODEL_PATH = "/tmp/anywhere-model.glb"
#: Where the generated subject goes on the desktop machine: the projects folder the container mounts
#: at /projects (kit.hero's default path). Relative to the SSH user's home.
HERO_FILE = "workspace/anywhere/projects/hero.glb"
#: Rendered pictures and their links stay valid this long (R2 allows up to 7 days).
LINK_SECONDS = 6 * 24 * 3600

# Export the subject, not the 400 m ground plane: a phone viewer frames the whole model,
# and a huge backdrop turned the subject into a speck.
_EXPORT = f"""
keep = set(kit.subject_objects())
for o in bpy.context.scene.objects:
    o.select_set(o in keep)
bpy.ops.export_scene.gltf(filepath={MODEL_PATH!r}, export_format="GLB", use_selection=True,
    export_apply=True, export_cameras=False, export_lights=False, export_animations=False)
print("exported", len(keep))
"""


async def _render(screen, samples: int = 32) -> bytes:
    """A GPU still of the scene camera, as JPEG bytes."""
    out = await run_in_blender(
        screen, f"kit.render_still(path={RENDER_PATH!r}, samples={samples}, width=1280, height=720)\nkit.show()"
    )
    if not out.startswith("ok"):
        raise RuntimeError(out.splitlines()[-1][:200] if out else "render failed")
    _, b64 = await screen.shell(f"base64 -w0 {RENDER_PATH}", timeout=30)
    return base64.b64decode(b64.strip())


async def quick_render(app: Anywhere, w: dict) -> bytes | None:
    """A camera render of whatever Blender shows, for "show me" (a desktop screenshot crops
    the scene into a corner of Blender's UI). None when there's no scene camera."""
    try:
        async with connect_screen(app.supervisor.remote(w), app.vault.agent_token(int(w["id"]))) as screen:
            probe = await run_in_blender(screen, "print(bool(bpy.context.scene.camera))")
            if "True" not in probe:
                return None
            return await _render(screen, samples=16)
    except Exception as exc:
        log.warning("scene.quick_render_failed", error=str(exc)[:200])
        return None


async def build(
    app: Anywhere,
    w: dict,
    request: str,
    *,
    conversation_id: int = 0,
    channel: str = "web",
    handle: str = "",
) -> None:
    """Build `request` in the desktop's Blender, render a still and a 3D model, and send them back.

    Progress and the picture go to the conversation the request came from and to the
    desktop's own chat, so the web shows what the phone asked for. A request that came by
    text gets exactly one text back: the picture with its 3D link."""
    wid = int(w["id"])
    owner = w["owner"]
    started = time.monotonic()
    targets = [c for c in dict.fromkeys([int(conversation_id or 0), int(w.get("conversationId") or 0)]) if c]
    title = request.strip().rstrip(".")

    async def post(kind: str, body: str) -> None:
        for cid in targets:
            try:
                await app.store.append_message(cid, "assistant", kind, body, wid, "system")
            except Exception as exc:
                log.warning("scene.post_failed", error=str(exc)[:200])

    async def fail(reason: str) -> None:
        await post("error", f"I couldn't build that one: {reason}")
        if channel == "imessage" and handle:
            await app.send_text(owner, handle, f"I couldn't build that one: {reason}")

    try:
        remote = app.supervisor.remote(w)
        hero = await pick_subject(app.settings, request) if app.settings.gen3d_host else None
        # Generate the subject's 3D model while the setting's script is being written.
        gen = asyncio.create_task(gen3d(app.settings, hero[0])) if hero else None
        code = await write_script(app.settings, request, hero=hero)
        model = await gen if gen else None
        await remote.run(f"rm -f {HERO_FILE}", timeout=20, check=False)
        if model:
            await remote.write_file(HERO_FILE, model)
        elif hero:
            log.info("scene.no_model", workload=wid)
            hero = None
        async with connect_screen(remote, app.vault.agent_token(wid)) as screen:
            outcome = await run_in_blender(screen, code)
            if not outcome.startswith("ok"):
                log.info("scene.retry", workload=wid, error=outcome[-300:])
                code = await write_script(app.settings, request, previous=code, error=outcome, hero=hero)
                outcome = await run_in_blender(screen, code)
            if not outcome.startswith("ok"):
                await fail(outcome.splitlines()[-1][:200])
                return
            built = time.monotonic() - started
            await post("status", f"Built {title} live in {built:.0f}s. Rendering on the GPU…")
            jpeg = await _render(screen)
            glb = b""
            if model:
                glb = model  # the generated subject itself: textured, and frames well on a phone
            else:
                exported = await run_in_blender(screen, _EXPORT)
                if exported.startswith("ok"):
                    _, b64 = await screen.shell(f"base64 -w0 {MODEL_PATH}", timeout=60)
                    glb = base64.b64decode(b64.strip())
        stamp = int(time.time())
        key = f"renders/{owner}/{wid}/{stamp}.jpg"
        await app.storage.put_bytes(key, jpeg, "image/jpeg")
        picture = app.storage.presign_get(key, LINK_SECONDS)
        viewer = ""
        if glb:
            token = secrets.token_urlsafe(18)
            mkey = f"models/{owner}/{wid}/{stamp}.glb"
            await app.storage.put_bytes(mkey, glb, "model/gltf-binary")
            app.vault.section_put("models", token, {"key": mkey, "title": title, "poster_url": picture})
            viewer = f"{app.settings.public_web_origin}/m/{token}"
        total = time.monotonic() - started
        await post(
            "image",
            json.dumps({"url": picture, "caption": f"{title}, rendered on the T4 in {total:.0f}s", "viewer": viewer}),
        )
        if channel == "imessage" and handle:
            text = f"Here's {title}, rendered on the GPU in {total:.0f}s."
            if viewer:
                text += f" Spin it in 3D: {viewer}"
            await app.send_text(owner, handle, text, key)
        log.info("scene.done", workload=wid, seconds=round(total, 1), model=bool(glb))
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        log.exception("scene.failed", workload=wid)
        await fail(str(exc)[:200])
