"""Blender startup script for Anywhere desktops (run with `blender --python`).

Gives the scene a home in ~/Projects (the folder Anywhere saves and restores) and
keeps it saved: every 20 s while there are unsaved changes, and right away when the
control plane touches /tmp/anywhere-save-now before it archives the project. Without
this, work done in an untitled scene was lost on Stop ("Project saved (0.0 MB)").

It also runs Python the desktop operator drops into /tmp/anywhere-run (NAME.py), inside
this Blender, so a whole procedural scene appears live in the open window instead of
being clicked together one menu at a time. The result (stdout, or the traceback) goes
to NAME.out for the operator to read back.
"""

import contextlib
import inspect as _inspect
import io
import math as _math
import os
import random as _random
import sys
import time
import traceback

import bpy
from mathutils import Vector as mathutils_Vector

PATH = os.path.expanduser("~/Projects/scene.blend")
FLAG = "/tmp/anywhere-save-now"
EVERY = 20.0
_last = [0.0]


def _home():
    try:
        if not bpy.data.filepath:
            os.makedirs(os.path.dirname(PATH), exist_ok=True)
            bpy.ops.wm.save_as_mainfile(filepath=PATH)
            _last[0] = time.monotonic()
    except Exception as exc:  # never break the user's session over this
        print("anywhere autosave: first save failed:", exc)
    return None


def _tick():
    try:
        asked = os.path.exists(FLAG)
        if asked:
            os.remove(FLAG)
        due = bpy.data.is_dirty and time.monotonic() - _last[0] >= EVERY
        if bpy.data.filepath and (asked or due):
            bpy.ops.wm.save_mainfile()
            _last[0] = time.monotonic()
    except Exception as exc:
        print("anywhere autosave:", exc)
    return 2.0


RUN_DIR = "/tmp/anywhere-run"


class kit:
    """Tested helpers the operator's scripts get as `kit`, so the model spends its steps on
    the scene rather than on Blender 4.5 API details it tends to misremember."""

    @staticmethod
    def clear():
        """Delete every object, and the meshes, materials and lights they leave behind."""
        for o in list(bpy.data.objects):
            bpy.data.objects.remove(o, do_unlink=True)
        for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras, bpy.data.curves):
            for block in list(coll):
                if block.users == 0:
                    coll.remove(block)
        # A fresh world too: skies used to pile up node after node across builds (17 of them),
        # and the last build's sky leaked into lighting and exposure decisions.
        scene = bpy.context.scene
        w = bpy.data.worlds.new("World")
        old, scene.world = scene.world, w
        w.use_nodes = True
        if old is not None and old.users == 0:
            bpy.data.worlds.remove(old)
        scene.view_settings.exposure = 0.0

    @staticmethod
    def material(name, color=(0.8, 0.8, 0.8), metallic=0.0, roughness=0.5, emission=None, strength=0.0):
        """A Principled material. emission=(r, g, b) with strength 5-30 makes it glow."""
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        b = m.node_tree.nodes["Principled BSDF"]
        b.inputs["Base Color"].default_value = (*color[:3], 1)
        b.inputs["Metallic"].default_value = metallic
        b.inputs["Roughness"].default_value = roughness
        if emission:
            b.inputs["Emission Color"].default_value = (*emission[:3], 1)
            b.inputs["Emission Strength"].default_value = strength
        return m

    @staticmethod
    def windows(name, wall=(0.02, 0.025, 0.035), glow=(1.0, 0.7, 0.35), strength=8.0, scale=2.0, lit=0.4, seed=0):
        """A building facade: dark glassy walls with a grid of randomly lit windows, all in the
        material (no extra objects). scale = windows per metre; lit = share of windows on."""
        m = kit.material(name, wall, metallic=0.6, roughness=0.25)
        n, link = m.node_tree.nodes, m.node_tree.links.new
        b = n["Principled BSDF"]
        coord = n.new("ShaderNodeTexCoord")
        xyz = n.new("ShaderNodeSeparateXYZ")
        across = n.new("ShaderNodeMath")
        across.operation = "ADD"
        facade = n.new("ShaderNodeCombineXYZ")  # (along the wall, up, 0): works on every side
        link(coord.outputs["Object"], xyz.inputs[0])
        link(xyz.outputs["X"], across.inputs[0])
        link(xyz.outputs["Y"], across.inputs[1])
        link(across.outputs[0], facade.inputs["X"])
        link(xyz.outputs["Z"], facade.inputs["Y"])
        brick = n.new("ShaderNodeTexBrick")
        brick.offset = 0.0
        brick.inputs["Scale"].default_value = 1.0
        brick.inputs["Brick Width"].default_value = 1.0 / scale
        brick.inputs["Row Height"].default_value = 1.4 / scale
        brick.inputs["Mortar Size"].default_value = 0.25 / scale
        brick.inputs["Mortar Smooth"].default_value = 0.0
        brick.inputs["Color1"].default_value = (1, 1, 1, 1)
        brick.inputs["Color2"].default_value = (1, 1, 1, 1)
        brick.inputs["Mortar"].default_value = (0, 0, 0, 1)
        link(facade.outputs[0], brick.inputs["Vector"])
        cell = n.new("ShaderNodeVectorMath")
        cell.operation = "SNAP"
        cell.inputs[1].default_value = (1.0 / scale, 1.4 / scale, 1.0)
        link(facade.outputs[0], cell.inputs[0])
        noise = n.new("ShaderNodeTexWhiteNoise")
        noise.noise_dimensions = "4D"
        noise.inputs["W"].default_value = seed
        link(cell.outputs["Vector"], noise.inputs["Vector"])
        on = n.new("ShaderNodeMath")
        on.operation = "LESS_THAN"
        on.inputs[1].default_value = lit
        link(noise.outputs["Value"], on.inputs[0])
        mask = n.new("ShaderNodeMath")
        mask.operation = "MULTIPLY"
        link(brick.outputs["Color"], mask.inputs[0])
        link(on.outputs[0], mask.inputs[1])
        normal = n.new("ShaderNodeSeparateXYZ")  # walls only: no windows on roofs
        link(coord.outputs["Normal"], normal.inputs[0])
        upright = n.new("ShaderNodeMath")
        upright.operation = "LESS_THAN"
        upright.inputs[1].default_value = 0.5
        upright.use_clamp = True
        roof = n.new("ShaderNodeMath")
        roof.operation = "ABSOLUTE"
        link(normal.outputs["Z"], roof.inputs[0])
        link(roof.outputs[0], upright.inputs[0])
        walls = n.new("ShaderNodeMath")
        walls.operation = "MULTIPLY"
        link(mask.outputs[0], walls.inputs[0])
        link(upright.outputs[0], walls.inputs[1])
        mask = walls
        power = n.new("ShaderNodeMath")
        power.operation = "MULTIPLY"
        power.inputs[1].default_value = strength
        link(mask.outputs[0], power.inputs[0])
        b.inputs["Emission Color"].default_value = (*glow[:3], 1)
        link(power.outputs[0], b.inputs["Emission Strength"])
        return m

    @staticmethod
    def box(name, location, size, material=None):
        """A box resting on its base at location (x, y, z), size (sx, sy, sz)."""
        import bmesh

        mesh = bpy.data.meshes.new(name)
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.translate(bm, vec=(0, 0, 0.5), verts=bm.verts)
        # Size baked into the mesh, not the object's scale, so textures keep real-world size.
        bmesh.ops.scale(bm, vec=size, verts=bm.verts)
        bm.to_mesh(mesh)
        bm.free()
        obj = bpy.data.objects.new(name, mesh)
        obj.location = location
        if material:
            mesh.materials.append(material)
        bpy.context.scene.collection.objects.link(obj)
        return obj

    @staticmethod
    def sphere(name, location, radius=1.0, material=None, segments=48):
        """A smooth UV sphere centred on location (planets, suns, orbs)."""
        import bmesh

        mesh = bpy.data.meshes.new(name)
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=segments // 2, radius=radius)
        bm.to_mesh(mesh)
        bm.free()
        for poly in mesh.polygons:
            poly.use_smooth = True
        obj = bpy.data.objects.new(name, mesh)
        obj.location = location
        if material:
            mesh.materials.append(material)
        bpy.context.scene.collection.objects.link(obj)
        return obj

    @staticmethod
    def world(color=(0.005, 0.007, 0.015), strength=1.0):
        """Background colour and ambient light (near black for night)."""
        scene = bpy.context.scene
        w = scene.world or bpy.data.worlds.new("World")
        scene.world = w
        w.use_nodes = True
        bg = w.node_tree.nodes.get("Background")
        bg.inputs["Color"].default_value = (*color[:3], 1)
        bg.inputs["Strength"].default_value = strength

    @staticmethod
    def sun(name="Sun", rotation=(0.9, 0.2, 0.6), color=(0.6, 0.7, 1.0), energy=1.5):
        """A sun lamp (moonlight with a cool colour and low energy)."""
        lamp = bpy.data.lights.new(name, "SUN")
        lamp.color = color[:3]
        lamp.energy = energy
        obj = bpy.data.objects.new(name, lamp)
        obj.rotation_euler = rotation
        bpy.context.scene.collection.objects.link(obj)
        return obj

    @staticmethod
    def orbit_camera(target=(0, 0, 0), radius=30.0, height=15.0, frames=120, lens=35.0):
        """A camera circling target once over `frames`, always aimed at it. Becomes the scene camera."""
        import math

        scene = bpy.context.scene
        pivot = bpy.data.objects.new("CameraOrbit", None)
        pivot.location = target
        scene.collection.objects.link(pivot)
        aim = bpy.data.objects.new("CameraTarget", None)
        aim.location = target
        scene.collection.objects.link(aim)
        cam = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
        cam.data.lens = lens
        cam.data.clip_end = max(1000.0, radius * 10)
        cam.location = (radius, 0, height)
        cam.parent = pivot
        scene.collection.objects.link(cam)
        track = cam.constraints.new("TRACK_TO")
        track.target = aim
        track.track_axis = "TRACK_NEGATIVE_Z"
        track.up_axis = "UP_Y"
        scene.camera = cam
        scene.frame_start, scene.frame_end = 1, frames
        edit = bpy.context.preferences.edit
        before, edit.keyframe_new_interpolation_type = edit.keyframe_new_interpolation_type, "LINEAR"
        try:  # linear, so the orbit doesn't ease in and out
            pivot.rotation_euler = (0, 0, 0)
            pivot.keyframe_insert("rotation_euler", frame=1)
            pivot.rotation_euler = (0, 0, 2 * math.pi)
            pivot.keyframe_insert("rotation_euler", frame=frames + 1)
        finally:
            edit.keyframe_new_interpolation_type = before
        return cam

    @staticmethod
    def glow(threshold=1.0, size=7):
        """Bloom around bright and emissive things, in renders and the rendered viewport."""
        scene = bpy.context.scene
        scene.use_nodes = True
        nt = scene.node_tree
        rl = next((x for x in nt.nodes if x.type == "R_LAYERS"), None) or nt.nodes.new("CompositorNodeRLayers")
        comp = next((x for x in nt.nodes if x.type == "COMPOSITE"), None) or nt.nodes.new("CompositorNodeComposite")
        glare = nt.nodes.new("CompositorNodeGlare")
        glare.glare_type = "FOG_GLOW"
        glare.threshold = threshold
        glare.size = size
        nt.links.new(rl.outputs["Image"], glare.inputs["Image"])
        nt.links.new(glare.outputs["Image"], comp.inputs["Image"])
        for area in _areas("VIEW_3D"):
            area.spaces[0].shading.use_compositor = "ALWAYS"

    @staticmethod
    def show(engine="BLENDER_EEVEE_NEXT", through_camera=True, shading="RENDERED"):
        """Point the viewport at the result: look through the scene camera, fully lit."""
        bpy.context.scene.render.engine = engine
        for area in _areas("VIEW_3D"):
            space = area.spaces[0]
            space.shading.type = shading
            if through_camera and bpy.context.scene.camera:
                space.region_3d.view_perspective = "CAMERA"

    @staticmethod
    def play():
        """Play the animation in the viewport."""
        if not bpy.context.screen.is_animation_playing:
            bpy.ops.screen.animation_play()

    @staticmethod
    def save():
        if bpy.data.filepath:
            bpy.ops.wm.save_mainfile()
        else:
            os.makedirs(os.path.dirname(PATH), exist_ok=True)
            bpy.ops.wm.save_as_mainfile(filepath=PATH)


# ── Fast-path builders (scene.py): high-level, forgiving, quick to write ──────────
#
# The model writes ~30 lines against these instead of 200 lines of raw bpy, which is
# what makes a judge's request appear in seconds. Every helper ignores arguments it
# doesn't know and accepts colours as (r, g, b), "#rrggbb" or a few names.

_NAMED = {
    "red": (0.9, 0.05, 0.05),
    "orange": (1.0, 0.35, 0.02),
    "yellow": (1.0, 0.85, 0.05),
    "green": (0.05, 0.7, 0.15),
    "cyan": (0.0, 0.85, 1.0),
    "blue": (0.05, 0.2, 1.0),
    "purple": (0.5, 0.05, 1.0),
    "magenta": (1.0, 0.0, 0.6),
    "pink": (1.0, 0.3, 0.6),
    "white": (1.0, 1.0, 1.0),
    "black": (0.01, 0.01, 0.01),
    "gray": (0.4, 0.4, 0.4),
    "grey": (0.4, 0.4, 0.4),
    "gold": (1.0, 0.7, 0.2),
    "silver": (0.8, 0.8, 0.85),
    "brown": (0.35, 0.18, 0.07),
}
NEON = [(1.0, 0.05, 0.6), (0.0, 0.9, 1.0), (0.55, 0.1, 1.0), (1.0, 0.45, 0.0), (0.1, 1.0, 0.4)]
_ALIASES = {
    "emission_strength": "strength",
    "emission_color": "emission",
    "emit": "emission",
    "position": "location",
    "pos": "location",
    "loc": "location",
    "colour": "color",
    "mat": "material",
    "size_xyz": "size",
    "rot": "rotation",
}


def _color(c, default=(0.8, 0.8, 0.8)):
    if c is None:
        return default
    if isinstance(c, str):
        c = c.strip().lower()
        if c in _NAMED:
            return _NAMED[c]
        h = c.lstrip("#")
        if len(h) == 6:
            try:
                return tuple(int(h[i : i + 2], 16) / 255 for i in (0, 2, 4))
            except ValueError:
                return default
        return default
    try:
        vals = [float(v) for v in list(c)[:3]]
        if max(vals) > 1.0:  # 0-255 colours
            vals = [v / 255 for v in vals]
        return tuple(vals) if len(vals) == 3 else default
    except (TypeError, ValueError):
        return default


def _vec(v, default=(0.0, 0.0, 0.0)):
    try:
        if hasattr(v, "location"):  # an object passed where a point was meant
            v = v.location
        vals = [float(x) for x in list(v)[:3]]
        return tuple(vals) if len(vals) == 3 else default
    except (TypeError, ValueError):
        return default


def _lenient(fn):
    """Rename common aliases, drop arguments fn doesn't take, never fail on extras."""
    sig = _inspect.signature(fn)
    names = set(sig.parameters)

    def wrapper(*args, **kwargs):
        clean = {}
        for k, v in kwargs.items():
            k = _ALIASES.get(k, k)
            if k in names:
                clean[k] = v
        return fn(*args, **clean)

    wrapper.__name__, wrapper.__doc__ = fn.__name__, fn.__doc__
    return staticmethod(wrapper)


def _material(name, color=(0.8, 0.8, 0.8), metallic=0.0, roughness=0.5, emission=None, strength=0.0):
    if emission is True:
        emission = color
    if emission is not None and not strength:
        strength = 10.0
    return _base_material(
        name, _color(color), metallic, roughness, _color(emission) if emission is not None else None, strength
    )


_base_material = kit.material
_base_box = kit.box
_base_sphere = kit.sphere
_base_world = kit.world
_base_sun = kit.sun
_base_orbit = kit.orbit_camera
kit.material = _lenient(_material)
kit.box = _lenient(
    lambda name, location=(0, 0, 0), size=(1, 1, 1), material=None: _base_box(
        name, _vec(location), _vec(size, (1, 1, 1)), material
    )
)
kit.sphere = _lenient(
    lambda name, location=(0, 0, 0), radius=1.0, material=None, segments=48: _base_sphere(
        name, _vec(location), float(radius), material, int(segments)
    )
)
kit.world = _lenient(lambda color=(0.005, 0.007, 0.015), strength=1.0: _base_world(_color(color), strength))
kit.sun = _lenient(
    lambda name="Sun", rotation=(0.9, 0.2, 0.6), color=(0.6, 0.7, 1.0), energy=1.5: _base_sun(
        name, _vec(rotation, (0.9, 0.2, 0.6)), _color(color), energy
    )
)


_BACKDROP = ("ground", "water", "terrain", "sea", "ocean", "floor", "plane", "sky")


def _subject_objects():
    """What the scene is about: visible meshes and text that aren't backdrop (ground, water,
    terrain, or anything far bigger than the rest)."""
    objs = [o for o in bpy.context.scene.objects if o.type in ("MESH", "CURVE", "FONT") and o.visible_get()]
    sized = [(o, max(o.dimensions) if o.dimensions else 0.0) for o in objs]
    keep = [o for o, d in sized if not any(k in o.name.lower() for k in _BACKDROP)]
    if keep:
        dims = sorted(max(o.dimensions) for o in keep)
        median = dims[len(dims) // 2] or 1.0
        keep = [o for o in keep if max(o.dimensions) <= max(median * 12, 30.0)]
    return keep or [o for o, d in sized]


def _orbit(target=(0, 0, 0), radius=30.0, height=15.0, frames=240, lens=35.0, subject=None):
    """Frames everything that isn't backdrop, plus `subject` if given. (Models pass a single part
    as the subject, and the camera then sat inside the rest of the scene.)"""
    hero = bpy.context.scene.objects.get("Hero")
    if hero is not None:
        subject = [hero]  # a generated subject is what the picture is of; frame it, not the props
    else:
        named = subject if isinstance(subject, (list, tuple)) else ([subject] if subject is not None else [])
        subject = list(dict.fromkeys([*_subject_objects(), *[o for o in named if hasattr(o, "matrix_world")]]))
    if subject is not None:
        objs = subject if isinstance(subject, (list, tuple)) else [subject]
        pts = []
        for o in objs:
            if hasattr(o, "matrix_world") and getattr(o, "bound_box", None):
                pts += [o.matrix_world @ mathutils_Vector(c) for c in o.bound_box]
        if pts:
            lo = [min(p[i] for p in pts) for i in range(3)]
            hi = [max(p[i] for p in pts) for i in range(3)]
            target = tuple((lo[i] + hi[i]) / 2 for i in range(3))
            span = max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1.0)
            w = max(hi[0] - lo[0], hi[1] - lo[1], 1.0)
            h = max(hi[2] - lo[2], 1.0)
            # Fit both ways for a 16:9 frame at 35 mm (about 54 deg wide, 32 deg tall), with margin.
            radius = max(w * 1.45, h * 2.6, span * 1.6)
            height = target[2] + radius * 0.22
    cam = _base_orbit(_vec(target), float(radius), float(height), int(frames), float(lens))
    if hero is not None:
        # Nothing may stand between the opening camera position (+X) and the subject.
        hx = hero.matrix_world.translation.x
        for o in bpy.context.scene.objects:
            if o is hero or o.type not in ("MESH", "CURVE", "FONT") or any(k in o.name.lower() for k in _BACKDROP):
                continue
            pts = [o.matrix_world @ mathutils_Vector(c) for c in o.bound_box]
            ahead = min(p.x for p in pts) > hx and min(abs(p.y - target[1]) for p in pts) < radius * 0.25
            if ahead and max(p.z for p in pts) > target[2] * 0.6:
                o.hide_render = True
                o.hide_viewport = True
    return cam


kit.orbit_camera = _lenient(_orbit)


def _reframe():
    """Replace the camera with one framed on the finished scene (the generated subject if there
    is one). Scripts sometimes set the camera up before placing the subject."""
    scene = bpy.context.scene
    for o in list(scene.objects):
        if o.name.startswith(("CameraOrbit", "CameraTarget")) or o.type == "CAMERA":
            bpy.data.objects.remove(o, do_unlink=True)
    return _orbit()


kit.reframe = staticmethod(_reframe)
for _n in ("windows", "glow", "show", "play", "save", "clear"):
    setattr(kit, _n, _lenient(getattr(kit, _n)))


def _mesh_object(name, bm, location, material, smooth=False):
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    if smooth:
        for poly in mesh.polygons:
            poly.use_smooth = True
    obj = bpy.data.objects.new(name, mesh)
    obj.location = _vec(location)
    if material:
        mesh.materials.append(material)
    bpy.context.scene.collection.objects.link(obj)
    return obj


@_lenient
def _cylinder(name, location=(0, 0, 0), radius=1.0, height=2.0, material=None, segments=32):
    """Standing on location."""
    import bmesh

    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=int(segments), radius1=radius, radius2=radius, depth=height)
    bmesh.ops.translate(bm, vec=(0, 0, height / 2), verts=bm.verts)
    return _mesh_object(name, bm, location, material, smooth=True)


@_lenient
def _cone(name, location=(0, 0, 0), radius=1.0, height=2.0, material=None, segments=32):
    """Standing on location (trees, spires, rockets)."""
    import bmesh

    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=int(segments), radius1=radius, radius2=0.0, depth=height)
    bmesh.ops.translate(bm, vec=(0, 0, height / 2), verts=bm.verts)
    return _mesh_object(name, bm, location, material)


@_lenient
def _torus(name, location=(0, 0, 0), radius=2.0, thickness=0.3, material=None, rotation=(0, 0, 0)):
    """A ring centred on location (planet rings, portals, halos)."""
    bpy.ops.mesh.primitive_torus_add(
        major_radius=radius, minor_radius=thickness, location=_vec(location), rotation=_vec(rotation)
    )
    obj = bpy.context.active_object
    obj.name = name
    if material:
        obj.data.materials.append(material)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


@_lenient
def _text(body, location=(0, 0, 0), size=3.0, material=None, extrude=0.3, rotation=(1.5708, 0, 1.5708)):
    """3D text standing up, facing +X, where kit.orbit_camera starts (names, signs, titles)."""
    curve = bpy.data.curves.new("Text", "FONT")
    curve.body = str(body)
    curve.size = size
    curve.extrude = extrude
    curve.align_x = "CENTER"
    obj = bpy.data.objects.new("Text", curve)
    obj.location = _vec(location)
    obj.rotation_euler = _vec(rotation, (1.5708, 0, 1.5708))
    if material:
        curve.materials.append(material)
    bpy.context.scene.collection.objects.link(obj)
    return obj


@_lenient
def _light(name="Light", location=(0, 0, 10), color=(1, 1, 1), energy=1000.0, kind="POINT", size=1.0):
    lamp = bpy.data.lights.new(
        name, str(kind).upper() if str(kind).upper() in ("POINT", "SPOT", "AREA", "SUN") else "POINT"
    )
    lamp.color = _color(color, (1, 1, 1))
    lamp.energy = energy
    if hasattr(lamp, "shadow_soft_size"):
        lamp.shadow_soft_size = size
    obj = bpy.data.objects.new(name, lamp)
    obj.location = _vec(location)
    bpy.context.scene.collection.objects.link(obj)
    return obj


@_lenient
def _ground(size=400.0, color=(0.02, 0.02, 0.03), roughness=0.3, metallic=0.2, grid=None, strength=4.0):
    """A big floor plane at z=0. grid=(r, g, b) adds glowing grid lines (synthwave, cyber)."""
    import bmesh

    m = _material("Ground", color, metallic, roughness)
    if grid is not None:
        n, link = m.node_tree.nodes, m.node_tree.links.new
        b = n["Principled BSDF"]
        coord = n.new("ShaderNodeTexCoord")
        brick = n.new("ShaderNodeTexBrick")
        brick.offset = 0.0
        link(coord.outputs["Object"], brick.inputs["Vector"])  # metres, not the plane's 0-1 UVs
        brick.inputs["Scale"].default_value = 0.2  # a line every 5 m
        brick.inputs["Brick Width"].default_value = 1.0
        brick.inputs["Row Height"].default_value = 1.0
        brick.inputs["Mortar Size"].default_value = 0.04
        brick.inputs["Color1"].default_value = (0, 0, 0, 1)
        brick.inputs["Color2"].default_value = (0, 0, 0, 1)
        brick.inputs["Mortar"].default_value = (1, 1, 1, 1)
        b.inputs["Emission Color"].default_value = (*_color(grid), 1)
        mul = n.new("ShaderNodeMath")
        mul.operation = "MULTIPLY"
        mul.inputs[1].default_value = strength
        link(brick.outputs["Color"], mul.inputs[0])
        link(mul.outputs[0], b.inputs["Emission Strength"])
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=size / 2)
    return _mesh_object("Ground", bm, (0, 0, 0), m)


@_lenient
def _city(blocks=8, spacing=7.0, max_height=45.0, palette="neon", seed=0, center=(0, 0, 0)):
    """A grid city of lit towers (with neon roof trims if palette="neon"). ~blocks*blocks buildings."""
    rng = _random.Random(seed)
    colors = NEON if palette == "neon" else [(1.0, 0.75, 0.4), (0.9, 0.9, 1.0), (1.0, 0.6, 0.3)]
    facades = [
        kit.windows(f"Facade{i}", glow=colors[i % len(colors)], strength=6, scale=1.6, lit=0.35 + 0.1 * i, seed=i)
        for i in range(len(colors))
    ]
    trims = [_material(f"Trim{i}", c, emission=c, strength=25) for i, c in enumerate(colors)]
    cx, cy, _ = _vec(center)
    half = (blocks - 1) * spacing / 2
    made = []
    for i in range(blocks):
        for j in range(blocks):
            if rng.random() < 0.12:
                continue  # plazas
            x, y = cx + i * spacing - half, cy + j * spacing - half
            d = _math.hypot(x - cx, y - cy) / max(half, 1)
            h = max(4.0, max_height * (1.1 - d) * rng.uniform(0.35, 1.0))
            w = rng.uniform(2.5, spacing * 0.7)
            k = rng.randrange(len(colors))
            made.append(_base_box(f"Tower_{i}_{j}", (x, y, 0), (w, w, h), facades[k]))
            if palette == "neon" and rng.random() < 0.6:
                made.append(_base_box(f"Trim_{i}_{j}", (x, y, h), (w * 1.02, w * 1.02, 0.25), trims[k]))
    return made


@_lenient
def _terrain(size=120.0, height=10.0, color=(0.12, 0.3, 0.08), seed=0, resolution=120, snow=False, flat=None):
    """Rolling hills or mountains from noise, flat at z=0 within `flat` metres of the centre
    (default size/8) so the subject stands on visible ground; snow=True whitens the peaks."""
    import bmesh
    from mathutils import Vector
    from mathutils import noise as mnoise

    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=int(resolution), y_segments=int(resolution), size=size / 2)
    off = Vector((seed * 13.7, seed * 7.3, 0))
    height = min(float(height), size * 0.12)  # tall noise on a small patch turns into spikes
    flat = size / 8 if flat is None else float(flat)
    for v in bm.verts:
        p = v.co.xy.to_3d() / (size * 0.5) + off
        hills = height * max(0.0, mnoise.fractal(p, 0.7, 2.0, 4) + 0.35)
        d = v.co.xy.length
        blend = 0.0 if d < flat else min(1.0, (d - flat) / max(flat, 1.0))
        v.co.z = hills * blend * blend * (3 - 2 * blend)
    m = _material("Terrain", color, roughness=0.9)
    if snow:
        n, link = m.node_tree.nodes, m.node_tree.links.new
        b = n["Principled BSDF"]
        geo = n.new("ShaderNodeNewGeometry")
        sep = n.new("ShaderNodeSeparateXYZ")
        ramp = n.new("ShaderNodeValToRGB")
        ramp.color_ramp.elements[0].position = 0.55
        ramp.color_ramp.elements[0].color = (*_color(color), 1)
        ramp.color_ramp.elements[1].position = 0.7
        ramp.color_ramp.elements[1].color = (0.95, 0.95, 1.0, 1)
        div = n.new("ShaderNodeMath")
        div.operation = "DIVIDE"
        div.inputs[1].default_value = height * 1.3
        link(geo.outputs["Position"], sep.inputs[0])
        link(sep.outputs["Z"], div.inputs[0])
        link(div.outputs[0], ramp.inputs["Fac"])
        link(ramp.outputs["Color"], b.inputs["Base Color"])
    return _mesh_object("Terrain", bm, (0, 0, 0), m, smooth=True)


@_lenient
def _trees(count=60, area=50.0, seed=0, height=4.0, leaves=(0.05, 0.35, 0.08), ground=None):
    """Low-poly trees scattered in a square of side `area`; if ground is the terrain, they sit on it."""
    rng = _random.Random(seed)
    bark = _material("Bark", (0.25, 0.13, 0.06), roughness=0.9)
    leaf = _material("Leaves", leaves, roughness=0.8)
    made = []
    for i in range(int(count)):
        x, y = rng.uniform(-area / 2, area / 2), rng.uniform(-area / 2, area / 2)
        z = 0.0
        if ground is not None:
            hit, loc, *_ = ground.ray_cast((x, y, 1000), (0, 0, -1)) if hasattr(ground, "ray_cast") else (False, None)
            if hit:
                z = loc.z
        s = height * rng.uniform(0.7, 1.3)
        made.append(_cylinder(f"Trunk{i}", (x, y, z), s * 0.06, s * 0.35, bark, 6))
        made.append(_cone(f"Crown{i}", (x, y, z + s * 0.3), s * 0.28, s * 0.8, leaf, 7))
    return made


@_lenient
def _starry_sky(color=(0.002, 0.003, 0.01), density=0.995, brightness=30.0):
    """A night sky full of stars as the world background."""
    scene = bpy.context.scene
    w = scene.world or bpy.data.worlds.new("World")
    scene.world = w
    w.use_nodes = True
    n, link = w.node_tree.nodes, w.node_tree.links.new
    bg = n.get("Background")
    bg.inputs["Color"].default_value = (*_color(color), 1)
    coord = n.new("ShaderNodeTexCoord")
    noise = n.new("ShaderNodeTexWhiteNoise")
    snap = n.new("ShaderNodeVectorMath")
    snap.operation = "SNAP"
    snap.inputs[1].default_value = (0.004, 0.004, 0.004)
    link(coord.outputs["Generated"], snap.inputs[0])
    link(snap.outputs["Vector"], noise.inputs["Vector"])
    ramp = n.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = density
    ramp.color_ramp.elements[0].color = (*_color(color), 1)
    ramp.color_ramp.elements[1].color = (brightness, brightness, brightness, 1)
    link(noise.outputs["Value"], ramp.inputs["Fac"])
    link(ramp.outputs["Color"], bg.inputs["Color"])


@_lenient
def _water(size=400.0, color=(0.01, 0.05, 0.1), z=0.0):
    """A glossy sea or lake plane at height z (reflects everything above it)."""
    import bmesh

    m = _material("Water", color, metallic=0.3, roughness=0.05)
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=size / 2)
    return _mesh_object("Water", bm, (0, 0, z), m)


def _is_daylight(world):
    """A world lit by the physical sky with the sun up (kit.sky day/noon/golden): the sky that
    actually feeds the background, not some leftover node."""
    try:
        bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
        link = bg.inputs["Color"].links[0] if bg.inputs["Color"].is_linked else None
        sky = link.from_node if link and link.from_node.type == "TEX_SKY" else None
        return bool(sky) and sky.sun_elevation > 0.15
    except (StopIteration, AttributeError, IndexError):
        return False


@_lenient
def _render_still(path="/tmp/anywhere-render.jpg", samples=24, width=960, height=540):
    """Render the camera view on the GPU with Cycles to a JPEG, exposed automatically; returns the path."""
    scene = bpy.context.scene
    before = scene.render.engine
    try:
        _gpu(scene)
        c = scene.cycles
        r = scene.render
        vs = scene.view_settings
        # Filmic colour with real contrast (the default transform blew pale subjects out to white).
        try:
            vs.view_transform = "AgX"
            vs.look = "AgX - Medium High Contrast"
        except TypeError:
            pass
        scene.frame_set(scene.frame_start)  # the orbit's opening view, which text faces
        r.image_settings.file_format = "JPEG"
        r.image_settings.quality = 93
        r.resolution_percentage = 100
        c.use_adaptive_sampling = True
        c.filter_width = 1.0
        c.use_denoising = True
        try:
            # OpenImageDenoise guided by albedo and normals keeps edges and detail the plain
            # denoiser smeared. On the CPU: its GPU path left streaks on the T4.
            c.denoiser = "OPENIMAGEDENOISE"
            c.denoising_input_passes = "RGB_ALBEDO_NORMAL"
            c.denoising_prefilter = "ACCURATE"
            c.denoising_use_gpu = False
        except (AttributeError, TypeError):
            pass

        _unfight_ground(scene)

        # Auto exposure: a tiny linear (EXR) preview, measured before tone mapping, sets exposure
        # so the median lands near mid-grey whatever lighting the script chose. A JPEG probe
        # saturated in bright worlds and could not see how far over they were.
        vs.exposure = 0.0
        r.resolution_x, r.resolution_y = 320, 180
        c.samples, c.adaptive_threshold = 16, 0.1
        fmt = r.image_settings.file_format
        r.image_settings.file_format = "OPEN_EXR"
        probe = "/tmp/anywhere-probe.exr"
        r.filepath = probe
        bpy.ops.render.render(write_still=True)
        r.image_settings.file_format = fmt
        try:
            img = bpy.data.images.load(probe, check_existing=False)
            px = img.pixels[:]
            bpy.data.images.remove(img)
            lum = [0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] for i in range(0, len(px), 16)]
            lum.sort()
            mid = lum[len(lum) // 2] if lum else 0.18  # median: a few bright sky pixels don't decide
            if mid > 1e-5:
                vs.exposure = max(-8.0, min(3.0, _math.log2(0.3 / mid)))
        except Exception as exc:
            print("anywhere exposure probe:", exc)

        r.resolution_x, r.resolution_y = int(width), int(height)
        c.samples, c.adaptive_threshold = max(int(samples), 48), 0.02
        r.filepath = path
        bpy.ops.render.render(write_still=True)
    finally:
        scene.render.engine = before
    return path


def _unfight_ground(scene):
    """Drop flat ground planes a hair below anything resting at the same height. Coplanar
    faces (a terrain's flat base on the ground plane) z-fight in Cycles as horizontal streaks."""
    for o in scene.objects:
        if o.type != "MESH" or o.get("anywhere_unfought") or o.dimensions.z > 1e-3:
            continue
        if max(o.dimensions.x, o.dimensions.y) < 20:
            continue
        o.location.z -= 0.02
        o["anywhere_unfought"] = True


def _gpu(scene):
    """Cycles on the GPU (OptiX, else CUDA)."""
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for kind in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
            if any(d.type == kind for d in prefs.devices):
                break
        except Exception:
            continue
    for d in prefs.devices:
        d.use = d.type != "CPU"
    scene.render.engine = "CYCLES"
    scene.cycles.device = "GPU"


@_lenient
def _show(through_camera=True, samples=24):
    """Live ray-traced view: the viewport renders with Cycles on the GPU, through the camera.
    (Blender's own preview draws on the CPU here, at ~2 fps; Cycles uses the T4.)"""
    scene = bpy.context.scene
    _gpu(scene)
    scene.cycles.preview_samples = int(samples)
    scene.cycles.use_preview_denoising = True
    if bpy.context.screen and bpy.context.screen.is_animation_playing:
        bpy.ops.screen.animation_cancel(restore_frame=False)
    scene.frame_set(scene.frame_start)
    for area in _areas("VIEW_3D"):
        space = area.spaces[0]
        space.shading.type = "RENDERED"
        if hasattr(space, "overlay"):
            space.overlay.show_overlays = False
        if through_camera and scene.camera:
            space.region_3d.view_perspective = "CAMERA"


@_lenient
def _play():
    """Kept for old scripts. Playing would re-render every frame in the ray-traced view."""
    return None


_SKY = {"day": 45.0, "noon": 70.0, "golden": 12.0, "sunset": 2.5, "dusk": 0.5, "dawn": 3.0, "sunrise": 3.0}


@_lenient
def _sky(time="day", rotation=0.0, strength=1.0):
    """A physical sky with a matching sun: time = day, noon, golden, sunset, sunrise, dawn, dusk or night."""
    t = str(time).lower()
    if t in ("night", "midnight", "space"):
        _starry_sky()
        _base_sun("Moon", (0.9, 0.2, 0.6), (0.6, 0.7, 1.0), 0.6)
        return
    elev = _SKY.get(t, 45.0)
    scene = bpy.context.scene
    w = scene.world or bpy.data.worlds.new("World")
    scene.world = w
    w.use_nodes = True
    n, link = w.node_tree.nodes, w.node_tree.links.new
    bg = n.get("Background")
    sky = n.new("ShaderNodeTexSky")
    try:
        sky.sky_type = "NISHITA"
        sky.sun_elevation = _math.radians(elev)
        sky.sun_rotation = float(rotation)
        sky.sun_intensity = 1.0
    except Exception:
        pass
    link(sky.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = strength * (0.35 if elev < 15 else 0.25)
    warm = (1.0, 0.55, 0.25) if elev < 15 else (1.0, 0.95, 0.88)
    # The physical sky already carries the sun's light; the lamp only adds crisp shadows.
    sun = _base_sun(
        "Sun", (_math.radians(90 - elev), 0.0, float(rotation) + _math.pi / 2), warm, 2.0 if elev > 15 else 2.5
    )
    if hasattr(sun.data, "angle"):
        sun.data.angle = _math.radians(1.5)


@_lenient
def _rocket(location=(0, 0, 0), height=14.0, color="white", accent="red", launching=True):
    """A rocket standing on location: body, nose, fins, engine and (launching=True) a flame with light."""
    x, y, z = _vec(location)
    if launching:
        z += height * 0.45  # clear of the ground, flame and smoke below
    body_m = _material("RocketBody", color, metallic=0.4, roughness=0.3)
    acc_m = _material("RocketAccent", accent, metallic=0.3, roughness=0.35)
    r = height * 0.08
    made = [_cylinder("RocketBody", (x, y, z + height * 0.12), r, height * 0.6, body_m, 48)]
    made.append(_cone("RocketNose", (x, y, z + height * 0.72), r, height * 0.28, acc_m, 48))
    for i in range(4):
        a = i * _math.pi / 2
        fin = _base_box(
            f"Fin{i}",
            (x + _math.cos(a) * r * 1.4, y + _math.sin(a) * r * 1.4, z + height * 0.12),
            (r * 1.4, r * 0.15, height * 0.18),
            acc_m,
        )
        fin.rotation_euler = (0, 0, a)
        made.append(fin)
    bell = _cone(
        "Engine",
        (x, y, z + height * 0.02),
        r * 0.7,
        height * 0.12,
        _material("Engine", (0.1, 0.1, 0.1), metallic=0.9, roughness=0.3),
        32,
    )
    bell.rotation_euler = (_math.pi, 0, 0)
    bell.location.z += height * 0.12
    made.append(bell)
    if launching:
        flame = _cone(
            "Flame",
            (x, y, z + height * 0.02),
            r * 0.65,
            height * 0.5,
            _material("Flame", (1.0, 0.45, 0.05), emission=(1.0, 0.5, 0.1), strength=40),
            32,
        )
        flame.rotation_euler = (_math.pi, 0, 0)
        flame.location.z += height * 0.0
        made.append(flame)
        made.append(_light("FlameLight", (x, y, z - height * 0.1), (1.0, 0.5, 0.15), 50000 * height / 14))
        smoke = _material("Smoke", (0.6, 0.6, 0.62), roughness=1.0)
        rng = _random.Random(7)
        for i in range(14):
            a, d = rng.uniform(0, 6.283), rng.uniform(r, r * 6)
            made.append(
                _base_sphere(
                    f"Smoke{i}",
                    (x + _math.cos(a) * d, y + _math.sin(a) * d, z - height * 0.35 + rng.uniform(0, r)),
                    rng.uniform(r, r * 3),
                    smoke,
                    16,
                )
            )
    return made


@_lenient
def _planet(
    name="Planet",
    location=(0, 0, 0),
    radius=6.0,
    color="orange",
    rings=False,
    ring_color=(0.85, 0.75, 0.55),
    glow=False,
):
    """A smooth planet, optionally ringed or glowing (a star)."""
    m = _material(name, color, roughness=0.6, emission=color if glow else None, strength=15 if glow else 0)
    made = [_base_sphere(name, _vec(location), float(radius), m, 64)]
    if rings:
        made.append(
            _torus(
                f"{name}Rings",
                location,
                radius * 1.8,
                radius * 0.25,
                _material(f"{name}RingM", ring_color, roughness=0.5),
                (1.2, 0.15, 0),
            )
        )
        made[-1].scale = (1, 1, 0.08)
    if glow:
        made.append(_light(f"{name}Light", location, color, 200000 * radius / 6))
    return made


@_lenient
def _hero(path="/projects/hero.glb", height=8.0, location=(0, 0, 0), rotation=0.0, roughness=0.55, metallic=0.0):
    """Place the generated 3D model of the subject: upright, `height` metres tall, standing on
    location, coloured from its baked vertex colours. Returns the object."""
    import os as _os

    if not _os.path.exists(path):
        raise FileNotFoundError("no generated model to place; build the subject from kit primitives instead")
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    if not meshes:
        raise RuntimeError("the generated model had no mesh")
    for o in new:
        if o.type != "MESH":
            o.parent = None
    obj = meshes[0]
    if len(meshes) > 1:
        with bpy.context.temp_override(active_object=obj, selected_editable_objects=meshes):
            bpy.ops.object.join()
    for o in new:
        if o.name in bpy.data.objects and o.type != "MESH":
            bpy.data.objects.remove(o, do_unlink=True)
    obj.name = "Hero"
    obj.parent = None
    bpy.context.view_layer.update()
    dims = obj.dimensions
    s = float(height) / max(dims.z, 1e-4)
    obj.scale = (obj.scale[0] * s, obj.scale[1] * s, obj.scale[2] * s)
    obj.rotation_euler.z += float(rotation)
    x, y, z = _vec(location)
    obj.location = (x, y, z)
    bpy.context.view_layer.update()
    pts = [obj.matrix_world @ mathutils_Vector(c) for c in obj.bound_box]
    cx = (min(p.x for p in pts) + max(p.x for p in pts)) / 2
    cy = (min(p.y for p in pts) + max(p.y for p in pts)) / 2
    obj.location = (obj.location.x + x - cx, obj.location.y + y - cy, obj.location.z + z - min(p.z for p in pts))
    mesh = obj.data
    for poly in mesh.polygons:
        poly.use_smooth = True
    m = bpy.data.materials.new("HeroMat")
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Roughness"].default_value = roughness
    b.inputs["Metallic"].default_value = metallic
    names = [a.name for a in getattr(mesh, "color_attributes", [])]
    if names:
        col = m.node_tree.nodes.new("ShaderNodeVertexColor")
        col.layer_name = names[0]
        # Generated colours come out pale; lift saturation and contrast so they read under
        # strong coloured light (sunsets washed them to beige).
        hsv = m.node_tree.nodes.new("ShaderNodeHueSaturation")
        hsv.inputs["Saturation"].default_value = 1.45
        hsv.inputs["Value"].default_value = 0.92
        bc = m.node_tree.nodes.new("ShaderNodeBrightContrast")
        bc.inputs["Contrast"].default_value = 0.18
        m.node_tree.links.new(col.outputs["Color"], hsv.inputs["Color"])
        m.node_tree.links.new(hsv.outputs["Color"], bc.inputs["Color"])
        m.node_tree.links.new(bc.outputs["Color"], b.inputs["Base Color"])
    mesh.materials.clear()
    mesh.materials.append(m)
    return obj


kit.show = _show
kit.hero = _hero
kit.play = _play

for _name, _fn in {
    "sky": _sky,
    "rocket": _rocket,
    "planet": _planet,
    "cylinder": _cylinder,
    "cone": _cone,
    "torus": _torus,
    "text": _text,
    "light": _light,
    "ground": _ground,
    "city": _city,
    "terrain": _terrain,
    "trees": _trees,
    "starry_sky": _starry_sky,
    "water": _water,
    "render_still": _render_still,
}.items():
    setattr(kit, _name, _fn)
kit.NEON = NEON
kit.subject_objects = staticmethod(_subject_objects)

# Scripts get kit as a global, and "import kit" (which models write anyway) finds it too.
sys.modules["kit"] = kit


def _areas(kind):
    screen = bpy.context.screen
    return [a for a in (screen.areas if screen else []) if a.type == kind]


def _view3d():
    """A context with the 3D viewport, so viewport operators work from a script."""
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:
            if area.type == "VIEW_3D":
                region = next((r for r in area.regions if r.type == "WINDOW"), None)
                ctx = {"window": window, "screen": window.screen, "area": area, "region": region}
                return {k: v for k, v in ctx.items() if v is not None}
    return {}


def _run(name):
    path = os.path.join(RUN_DIR, name)
    with open(path) as f:
        source = f.read()
    os.remove(path)  # gone means picked up; the operator cleans up scripts never picked up
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out), bpy.context.temp_override(**_view3d()):
            import math
            import random

            import bmesh
            import mathutils

            namespace = {"__name__": "__main__", "bpy": bpy, "bmesh": bmesh, "kit": kit}
            namespace.update(math=math, random=random, mathutils=mathutils)
            exec(compile(source, name, "exec"), namespace)
        result = "ok\n" + out.getvalue()
    except Exception:
        result = "error\n" + out.getvalue()[-1500:] + traceback.format_exc(limit=6)
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:
            area.tag_redraw()
    done = os.path.join(RUN_DIR, name[:-3] + ".out")
    with open(done + ".tmp", "w") as f:
        f.write(result[-6000:])
    os.replace(done + ".tmp", done)


def _scripts():
    try:
        if os.path.isdir(RUN_DIR):
            for name in sorted(os.listdir(RUN_DIR)):
                if name.endswith(".py"):
                    _run(name)
    except Exception as exc:
        print("anywhere runner:", exc)
    return 0.5


bpy.app.timers.register(_home, first_interval=1.0)
bpy.app.timers.register(_tick, first_interval=3.0, persistent=True)
bpy.app.timers.register(_scripts, first_interval=2.0, persistent=True)
