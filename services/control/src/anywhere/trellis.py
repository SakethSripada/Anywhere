"""Text-to-3D with Microsoft TRELLIS on build.nvidia.com (same NVIDIA key as Nemotron).

Returns a textured GLB for a short object description. This is what makes a judge's
"render a pirate ship" look like a pirate ship: the hero object is generated, not
stacked from cylinders by a language model.
"""

from __future__ import annotations

import base64
import time

import httpx
import structlog

from .config import Settings
from .llm import _key

log = structlog.get_logger()

URL = "https://ai.api.nvidia.com/v1/genai/microsoft/trellis"
#: The API documents a 77-character prompt limit.
MAX_PROMPT = 77


class TrellisError(Exception):
    pass


async def generate(settings: Settings, prompt: str, seed: int = 0, timeout: float = 120) -> bytes:
    """One textured GLB for `prompt` (an object description, not a scene)."""
    body = {
        "prompt": prompt.strip()[:MAX_PROMPT],
        "mode": "text",
        "seed": seed,
        "output_format": "glb",
        "slat_sampling_steps": 25,
        "ss_sampling_steps": 25,
    }
    headers = {"Authorization": f"Bearer {_key(settings)}", "Accept": "application/json"}
    started = time.monotonic()
    async with httpx.AsyncClient(timeout=timeout) as http:
        res = await http.post(URL, json=body, headers=headers)
    if res.status_code != 200:
        raise TrellisError(f"TRELLIS returned {res.status_code}: {res.text[:200]}")
    artifacts = (res.json() or {}).get("artifacts") or []
    if not artifacts or artifacts[0].get("finishReason") != "SUCCESS":
        reason = artifacts[0].get("finishReason") if artifacts else "no artifact"
        raise TrellisError(f"TRELLIS didn't make a model ({reason})")
    glb = base64.b64decode(artifacts[0]["base64"])
    if glb[:4] != b"glTF":
        raise TrellisError("TRELLIS returned something that isn't a GLB")
    log.info("trellis.done", seconds=round(time.monotonic() - started, 1), bytes=len(glb))
    return glb
