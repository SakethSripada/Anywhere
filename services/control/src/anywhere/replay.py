"""Replays of the desktop agent: what it saw at each step and what it did next.

The operator records an "observe" step with the screenshot it decided on, then an
"act" step describing the action (in that screenshot's pixel space). Pairing them
gives one replay frame per decision: the picture, a caption, the reasoning and,
for pointer actions, where it clicked. `timelapse_gif` turns those frames into a
shareable animation with the caption and the click drawn in.
"""

from __future__ import annotations

import io
import json
from typing import Any

from PIL import Image, ImageDraw, ImageFont

POINTER = {"click", "double_click", "right_click", "move", "drag", "scroll"}
GIF_WIDTH = 960
FRAME_MS = 900
HOLD_LAST_MS = 2500


def frames_from_steps(steps: list[dict]) -> list[dict[str, Any]]:
    """One frame per screenshot, captioned with the action taken on it (if any)."""
    ordered = sorted(steps, key=lambda s: int(s.get("seq", 0)))
    frames: list[dict[str, Any]] = []
    for i, s in enumerate(ordered):
        if s.get("kind") != "observe" or not s.get("screenshotKey"):
            continue
        frame: dict[str, Any] = {"key": s["screenshotKey"], "caption": "Looked at the screen", "kind": "observe"}
        nxt = next((t for t in ordered[i + 1 :] if t.get("kind") != "observe"), None)
        if nxt is not None and not _observed_between(ordered, s, nxt):
            frame["caption"] = nxt.get("summary") or frame["caption"]
            frame["kind"] = nxt.get("kind", "act")
            detail = _json(nxt.get("detail"))
            frame["thought"] = (detail.get("thought") or "")[:400]
            if nxt.get("kind") in ("done", "error") and nxt.get("detail"):
                frame["thought"] = str(nxt["detail"])[:400]
            if detail.get("action") in POINTER and detail.get("x") is not None and detail.get("y") is not None:
                frame["point"] = [int(detail["x"]), int(detail["y"])]
            if detail.get("action") == "drag" and detail.get("x2") is not None:
                frame["point_to"] = [int(detail["x2"]), int(detail.get("y2") or 0)]
            if isinstance(detail.get("frame"), list) and len(detail["frame"]) == 2:
                frame["size"] = [int(detail["frame"][0]), int(detail["frame"][1])]
        frames.append(frame)
    return frames


def _observed_between(steps: list[dict], a: dict, b: dict) -> bool:
    lo, hi = int(a.get("seq", 0)), int(b.get("seq", 0))
    return any(s.get("kind") == "observe" and lo < int(s.get("seq", 0)) < hi for s in steps)


def _json(text: Any) -> dict:
    try:
        value = json.loads(text) if isinstance(text, str) and text.startswith("{") else {}
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _font(size: int) -> ImageFont.ImageFont:
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    # Slim containers have no system fonts; Pillow's bundled default scales (Pillow >= 10.1).
    return ImageFont.load_default(size=size)


def timelapse_gif(images: list[bytes], frames: list[dict], title: str) -> bytes:
    """Render frames (JPEG bytes, same order as `frames`) into an annotated animated GIF."""
    if not images:
        raise ValueError("no frames to render")
    font, small = _font(22), _font(16)
    out: list[Image.Image] = []
    for n, (jpeg, f) in enumerate(zip(images, frames, strict=True), start=1):
        img = Image.open(io.BytesIO(jpeg)).convert("RGB")
        scale = GIF_WIDTH / img.width
        img = img.resize((GIF_WIDTH, round(img.height * scale)), Image.LANCZOS)
        draw = ImageDraw.Draw(img)
        if f.get("point"):
            sx, sy = _scale_point(f["point"], f.get("size"), img.size, scale)
            for r, width in ((22, 4), (10, 3)):
                draw.ellipse((sx - r, sy - r, sx + r, sy + r), outline=(74, 222, 128), width=width)
            if f.get("point_to"):
                tx, ty = _scale_point(f["point_to"], f.get("size"), img.size, scale)
                draw.line((sx, sy, tx, ty), fill=(74, 222, 128), width=4)
                draw.ellipse((tx - 7, ty - 7, tx + 7, ty + 7), fill=(74, 222, 128))
        bar = 64
        draw.rectangle((0, img.height - bar, img.width, img.height), fill=(10, 10, 11))
        draw.text((18, img.height - bar + 10), _clip(f.get("caption", ""), 70), fill=(236, 236, 238), font=font)
        draw.text(
            (18, img.height - bar + 38),
            f"{_clip(title, 60)}  ·  step {n} of {len(frames)}",
            fill=(142, 142, 150),
            font=small,
        )
        out.append(img.convert("P", palette=Image.ADAPTIVE, colors=200))
    buf = io.BytesIO()
    durations = [FRAME_MS] * (len(out) - 1) + [HOLD_LAST_MS]
    out[0].save(buf, format="GIF", save_all=True, append_images=out[1:], duration=durations, loop=0, optimize=True)
    return buf.getvalue()


def _scale_point(point: list[int], size: list[int] | None, out_size: tuple[int, int], scale: float) -> tuple[int, int]:
    # Points are in the screenshot the model saw; that's the stored JPEG unless a size says otherwise.
    if size and size[0] > 0 and size[1] > 0:
        return round(point[0] * out_size[0] / size[0]), round(point[1] * out_size[1] / size[1])
    return round(point[0] * scale), round(point[1] * scale)


def _clip(text: str, n: int) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[: n - 1] + "…"
