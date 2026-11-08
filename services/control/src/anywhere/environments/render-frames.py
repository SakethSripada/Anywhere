"""Render frames on the GPU and report progress for Anywhere's job monitor.

    blender -b project/scene.blend -P render-frames.py -- config.json

config.json: {"frames": 24, "offset": 0, "samples": null}. Renders `frames` frames
starting `offset` frames after the scene's start frame (a split render's part), with the
scene's own settings otherwise. Frames keep their real numbers, so parts merge cleanly.
"""

import json
import sys
import time
from pathlib import Path

import bpy

job = Path.cwd()
cfg = json.loads(Path(sys.argv[sys.argv.index("--") + 1]).read_text())
scene = bpy.context.scene
scene.render.engine = "CYCLES"

prefs = bpy.context.preferences.addons["cycles"].preferences
device = "CPU"
for kind in ("OPTIX", "CUDA"):
    try:
        prefs.compute_device_type = kind
        prefs.get_devices()
    except TypeError:
        continue
    gpus = [d for d in prefs.devices if d.type == kind]
    if gpus:
        for d in prefs.devices:
            d.use = d.type == kind
        scene.cycles.device = "GPU"
        device = f"{kind}: {gpus[0].name}"
        break
print(f"::step:: Rendering on {device}", flush=True)
if device == "CPU":
    print("No GPU render device found; refusing to render on the CPU", flush=True)
    sys.exit(3)

if cfg.get("samples"):
    scene.cycles.samples = int(cfg["samples"])

total = max(1, int(cfg.get("frames") or 1))
offset = max(0, int(cfg.get("offset") or 0))  # a split render's part starts this many frames in
out = job / "renders"
out.mkdir(exist_ok=True)
with (job / "metrics.jsonl").open("a") as metrics:
    first = scene.frame_start + offset
    for done, frame in enumerate(range(first, first + total), start=1):
        scene.frame_set(frame)
        scene.render.filepath = str(out / f"frame_{frame:04d}")
        start = time.perf_counter()
        bpy.ops.render.render(write_still=True)
        seconds = time.perf_counter() - start
        metrics.write(json.dumps({"frame": frame, "done": done, "total": total, "seconds": round(seconds, 2)}) + "\n")
        metrics.flush()
        print(f"::step:: Rendered frame {done} of {total} ({seconds:.0f}s)", flush=True)
