"""Cycles render-time estimates, grounded in measured GPU throughput.

The numbers below are medians from Blender Open Data (opendata.blender.org,
CC0), daily snapshot of 2026-11-08: single-GPU OptiX runs on Blender 4.5.x,
the release Anywhere desktops install. Each value is Cycles *samples per minute*
for one of the three benchmark scenes, rendered with adaptive sampling off and a
30-second time limit. `runs` is how many submissions the median comes from, so a
thin GPU (one run) can be reported as less certain.

The scenes stand in for scene complexity:
  simple   -> "monster"    (character, simple lighting)
  detailed -> "junkshop"   (dense props, textures, mixed lighting)
  heavy    -> "classroom"  (interior global illumination), times HEAVY_EXTRA for
              volumetrics and many lights. That multiplier is a planning
              heuristic, not a measurement.

Converting samples per minute into minutes per frame needs the benchmark frame
size. The benchmark renders each scene at the resolution saved in its file and
doesn't publish it, so we assume about 1080p (REFERENCE_PIXELS) and widen the
range to cover being off by a factor of ~2. A test render on the actual machine
(see `Anywhere.estimate_render`) replaces all of this with a measurement.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Complexity = Literal["simple", "detailed", "heavy"]

#: GPU -> scene -> (samples per minute, runs).
SAMPLES_PER_MINUTE: dict[str, dict[str, tuple[float, int]]] = {
    "T4": {"monster": (692.6, 1), "junkshop": (425.5, 1), "classroom": (383.5, 1)},
    "L4": {"monster": (1723.9, 8), "junkshop": (872.6, 8), "classroom": (870.9, 8)},
    "A10G": {"monster": (1490.4, 3), "junkshop": (856.4, 3), "classroom": (764.7, 3)},
    "L40S": {"monster": (4024.8, 8), "junkshop": (1882.5, 8), "classroom": (2003.5, 8)},
    "A100": {"monster": (1550.3, 3), "junkshop": (1186.9, 3), "classroom": (911.4, 3)},
    "H100": {"monster": (2494.1, 1), "junkshop": (1943.8, 1), "classroom": (1491.6, 1)},
}
SCENE: dict[str, str] = {"simple": "monster", "detailed": "junkshop", "heavy": "classroom"}
HEAVY_EXTRA = 2.0
REFERENCE_PIXELS = 1920 * 1080
#: The spread around the midpoint: resolution assumption, scene variance, denoising.
LOW, HIGH = 0.6, 1.8


@dataclass(frozen=True)
class FrameEstimate:
    gpu: str
    minutes_low: float
    minutes_mid: float
    minutes_high: float
    runs: int

    def public(self) -> dict:
        return {
            "gpu": self.gpu,
            "minutes_low": round(self.minutes_low, 2),
            "minutes_high": round(self.minutes_high, 2),
            "benchmark_runs": self.runs,
        }


def gpu_key(name: str) -> str | None:
    """Map a GPU name ("L4", "NVIDIA A10G", "Tesla T4", "A100 80GB") to a table row."""
    words = name.upper().replace("NVIDIA", " ").replace("TESLA", " ").split()
    first = words[0].split("-")[0] if words else ""
    return first if first in SAMPLES_PER_MINUTE else None


def frame_minutes(
    gpu: str, complexity: Complexity = "detailed", width: int = 1920, height: int = 1080, samples: int = 128
) -> FrameEstimate | None:
    """Minutes to render one frame on `gpu`, as a range. None if the GPU isn't benchmarked."""
    key = gpu_key(gpu)
    if key is None:
        return None
    spm, runs = SAMPLES_PER_MINUTE[key][SCENE[complexity]]
    mid = samples / spm * (width * height / REFERENCE_PIXELS)
    if complexity == "heavy":
        mid *= HEAVY_EXTRA
    high = mid * HIGH * (1.3 if runs < 3 else 1.0)  # one or two runs: be less sure
    return FrameEstimate(key, mid * LOW, mid, high, runs)


def relative_speed(gpu: str, than: str, complexity: Complexity = "detailed") -> float | None:
    """How many times faster `gpu` renders than `than` for this kind of scene."""
    a, b = gpu_key(gpu), gpu_key(than)
    if not a or not b:
        return None
    scene = SCENE[complexity]
    return SAMPLES_PER_MINUTE[a][scene][0] / SAMPLES_PER_MINUTE[b][scene][0]


def extrapolate(probe: dict, frames: int = 1) -> dict:
    """Turn a render-probe measurement into seconds per full frame.

    Two timed renders at the probe size give a per-sample-per-pixel cost (the slope)
    and a fixed per-frame overhead (the intercept); the full frame is overhead plus
    slope times full samples times full pixels."""
    (s1, t1), (s2, t2) = probe["points"]
    probe_px = max(1, probe["probe_width"] * probe["probe_height"])
    full_px = max(1, probe["full_width"] * probe["full_height"])
    per = (t2 - t1) / ((s2 - s1) * probe_px)
    if per <= 0:
        # Timing noise swamped the difference (a trivially light scene): fall back to
        # treating the larger render as all sampling work.
        per, overhead = t2 / (s2 * probe_px), 0.0
    else:
        overhead = max(0.0, t1 - per * s1 * probe_px)
    seconds = overhead + per * probe["target_samples"] * full_px
    return {
        "seconds_per_frame": round(seconds, 1),
        "frames": frames,
        "total_minutes": round(seconds * frames / 60, 1),
        "overhead_seconds": round(overhead, 2),
    }
