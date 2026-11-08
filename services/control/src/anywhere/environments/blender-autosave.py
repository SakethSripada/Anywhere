"""Blender startup script for Anywhere desktops (run with `blender --python`).

Gives the scene a home in ~/Projects (the folder Anywhere saves and restores) and
keeps it saved: every 20 s while there are unsaved changes, and right away when the
control plane touches /tmp/anywhere-save-now before it archives the project. Without
this, work done in an untitled scene was lost on Stop ("Project saved (0.0 MB)").
"""

import os
import time

import bpy

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


bpy.app.timers.register(_home, first_interval=1.0)
bpy.app.timers.register(_tick, first_interval=3.0, persistent=True)
