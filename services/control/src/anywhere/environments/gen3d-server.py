"""Text-to-3D server for an Anywhere GPU box: SDXL-Turbo makes an object picture, TripoSR
turns it into a coloured mesh, returned as GLB. Runs on the host (not in Docker):

    python gen3d-server.py            # listens on 127.0.0.1:7860

POST /generate {"prompt": "a pirate ship", "seed": 0}  ->  model/gltf-binary
GET  /health                                          ->  {"ok": true}

The control plane reaches it over SSH (curl on the box), so it never listens publicly.
"""

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import rembg
import torch
import trimesh
from diffusers import AutoPipelineForText2Image
from PIL import Image

sys.path.insert(0, "/opt/TripoSR")
from tsr.system import TSR  # noqa: E402
from tsr.utils import remove_background, resize_foreground, to_gradio_3d_orientation  # noqa: E402

DEVICE = "cuda"
# Phrased as a figurine with wide margins: image models then draw the whole subject, uncropped
# and without a base, which is what TripoSR needs to rebuild a clean, complete mesh.
STYLE = (
    "a miniature figurine of {p}, full body, the whole figurine small in the center of an empty pure white "
    "background with wide empty margins on every side, side three-quarter view, no base, no ground, "
    "highly detailed, vibrant colors, studio product photo"
)

print("loading SDXL-Turbo", flush=True)  # draws one complete subject on white far more reliably than SD-Turbo
pipe = AutoPipelineForText2Image.from_pretrained(
    "stabilityai/sdxl-turbo", torch_dtype=torch.float16, variant="fp16"
).to(DEVICE)
pipe.set_progress_bar_config(disable=True)
print("loading TripoSR", flush=True)
model = TSR.from_pretrained("stabilityai/TripoSR", config_name="config.yaml", weight_name="model.ckpt")
model.renderer.set_chunk_size(8192)
model.to(DEVICE)
session = rembg.new_session()
lock = threading.Lock()
print("ready", flush=True)


def generate(prompt: str, seed: int = 0) -> tuple[bytes, dict]:
    t0 = time.time()
    g = torch.Generator(DEVICE).manual_seed(int(seed) or 42)
    image = pipe(
        prompt=STYLE.format(p=prompt.strip()),
        num_inference_steps=4,
        guidance_scale=0.0,
        width=512,
        height=512,
        generator=g,
    ).images[0]
    t1 = time.time()
    image.save("/tmp/gen3d-last.png")  # the picture TripoSR worked from, for debugging
    fg = resize_foreground(remove_background(image, session), 0.85)
    arr = np.array(fg).astype(np.float32) / 255.0
    arr = arr[:, :, :3] * arr[:, :, 3:4] + (1 - arr[:, :, 3:4]) * 0.5
    fg = Image.fromarray((arr * 255.0).astype(np.uint8))
    with torch.no_grad():
        codes = model([fg], device=DEVICE)
        mesh = model.extract_mesh(codes, True, resolution=320)[
            0
        ]  # 320: ~60% more triangles than 256 for ~2.5 s; edges stop looking lumpy
    # Marching cubes leaves contour-line ridges on smooth surfaces (car hoods, hulls). Taubin
    # smoothing removes them without shrinking the shape or rounding off wings and fins.
    trimesh.smoothing.filter_taubin(mesh, lamb=0.5, nu=-0.53, iterations=12)
    if mesh.is_watertight and mesh.volume < 0:
        mesh.invert()  # inward-facing triangles render black in browsers that cull back faces
    mesh = to_gradio_3d_orientation(mesh)  # standard Y-up GLB: upright in Blender and in browsers
    t2 = time.time()
    glb = mesh.export(file_type="glb")
    return glb, {"image_s": round(t1 - t0, 2), "mesh_s": round(t2 - t1, 2), "faces": int(len(mesh.faces))}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code: int, body: bytes, kind: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, b'{"ok": true}', "application/json")
        else:
            self._send(404, b"{}", "application/json")

    def do_POST(self):
        if self.path != "/generate":
            return self._send(404, b"{}", "application/json")
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0) or b"{}")
            with lock:
                glb, stats = generate(str(req.get("prompt", ""))[:300], int(req.get("seed", 0)))
            self._send(200, glb, "model/gltf-binary", {"X-Stats": json.dumps(stats)})
            print("generated", req.get("prompt"), stats, flush=True)
        except Exception as exc:  # report, keep serving
            self._send(500, json.dumps({"error": str(exc)[:500]}).encode(), "application/json")


ThreadingHTTPServer(("127.0.0.1", 7860), Handler).serve_forever()
