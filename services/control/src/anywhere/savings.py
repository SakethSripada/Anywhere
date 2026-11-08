"""What auto-stopping idle desktops saved, without inventing a counterfactual.

When the guard stops an idle desktop we record when, at what rate, and when the
session limit would have stopped it anyway. The saving is the time between the
idle stop and the earliest of: that limit, the user resuming it, or now. Past
the session limit the machine would have been stopped regardless, so that time
is never counted.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

SECTION = "idle_stops"


def record(stopped_at: datetime, segment_start: datetime | None, max_session_hours: float, w: dict) -> dict:
    start = segment_start or stopped_at
    return {
        "owner": w["owner"],
        "workload_id": int(w["id"]),
        "title": w["title"],
        "gpu": w.get("gpuName") or "",
        "hourly_cents": int(w["hourlyCents"]),
        "stopped_at": stopped_at.isoformat(),
        "limit_at": max(stopped_at, start + timedelta(hours=max_session_hours)).isoformat(),
        "resumed_at": None,
    }


def saved_cents(stop: dict, now: datetime | None = None) -> float:
    now = now or datetime.now(UTC)
    stopped = datetime.fromisoformat(stop["stopped_at"])
    end = min(datetime.fromisoformat(stop["limit_at"]), now)
    if stop.get("resumed_at"):
        end = min(end, datetime.fromisoformat(stop["resumed_at"]))
    return max(0.0, (end - stopped).total_seconds() / 3600 * int(stop["hourly_cents"]))


def still_counting(stop: dict, now: datetime | None = None) -> bool:
    now = now or datetime.now(UTC)
    return not stop.get("resumed_at") and now < datetime.fromisoformat(stop["limit_at"])
