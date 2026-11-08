"""Time two small test renders of the open .blend and extrapolate to the full frame.

Run by Anywhere inside the desktop container:
    blender -b scene.blend -P render-probe.py -- '{"samples": 256, "percent": 25}'
Prints one line, `::probe::{json}`, with the measurements.

A warm-up render at 1 sample absorbs one-time costs (loading, kernel compile).
Two timed renders at the same reduced resolution and different sample counts
then separate the per-sample cost from the fixed per-frame overhead (scene
sync, BVH), which is what makes the extrapolation trustworthy.
"""

import json
import sys
import time

import bpy

args = json.loads(sys.argv[sys.argv.index("--") + 1]) if "--" in sys.argv else {}
scene = bpy.context.scene
scene.render.engine = "CYCLES"

device = "CPU"
prefs = bpy.context.preferences.addons["cycles"].preferences
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

full_w = int(scene.render.resolution_x * scene.render.resolution_percentage / 100)
full_h = int(scene.render.resolution_y * scene.render.resolution_percentage / 100)
target = int(args.get("samples") or scene.cycles.samples)
percent = int(args.get("percent", 25))

scene.cycles.use_adaptive_sampling = False  # fixed sample counts, so time scales with samples
scene.cycles.use_denoising = False  # denoising is a small, separate cost; reported as such
scene.render.resolution_percentage = max(1, scene.render.resolution_percentage * percent // 100)
probe_w = int(scene.render.resolution_x * scene.render.resolution_percentage / 100)
probe_h = int(scene.render.resolution_y * scene.render.resolution_percentage / 100)


def timed(samples: int) -> float:
    scene.cycles.samples = samples
    start = time.perf_counter()
    bpy.ops.render.render(write_still=False)
    return time.perf_counter() - start


timed(1)  # warm-up
s1, s2 = 8, 32
t1, t2 = timed(s1), timed(s2)

print(
    "::probe::"
    + json.dumps(
        {
            "device": device,
            "full_width": full_w,
            "full_height": full_h,
            "target_samples": target,
            "probe_width": probe_w,
            "probe_height": probe_h,
            "points": [[s1, t1], [s2, t2]],
            "frame_start": scene.frame_start,
            "frame_end": scene.frame_end,
        }
    ),
    flush=True,
)
