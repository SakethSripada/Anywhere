"""The small, verified set of machines Anywhere is allowed to provision.

We deliberately do not expose Brev's full 300+ instance marketplace. Each entry
here was chosen for a reason (cheapest T4, best-value 24 GB card, 48 GB for
larger fine-tunes), is stoppable so desktops survive a stop, and has a price
snapshot taken from Brev's public instance-type feed. At runtime the snapshot
is overlaid with live prices from `brev search gpu --json` whenever the CLI is
reachable, and every price carries its source and timestamp so the UI never
presents a stale number as current.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Literal

import structlog

log = structlog.get_logger()

SNAPSHOT_AS_OF = datetime(2026, 11, 7, tzinfo=UTC)

#: Rough relative training/render throughput, normalised to an L4. These are
#: heuristics for ranking and runtime ranges, never presented as benchmarks.
GPU_SPEED: dict[str, float] = {"T4": 0.45, "L4": 1.0, "A10G": 1.2, "L40S": 2.6}


@dataclass(frozen=True)
class Offer:
    type: str
    provider: str
    gpu_name: str
    gpu_count: int
    vram_gb: float
    vcpus: int
    ram_gb: float
    price_per_hour: float
    stoppable: bool
    boot_minutes: int
    #: Whether we have a tested desktop configuration for this machine class.
    desktop_ready: bool
    label: str
    price_source: Literal["snapshot", "live"] = "snapshot"
    price_as_of: datetime = SNAPSHOT_AS_OF

    @property
    def speed(self) -> float:
        return GPU_SPEED.get(self.gpu_name, 1.0) * self.gpu_count

    @property
    def hourly_cents(self) -> int:
        return int(round(self.price_per_hour * 100))

    def public(self) -> dict:
        return {
            "type": self.type,
            "provider": self.provider,
            "gpu": f"{self.gpu_count}× {self.gpu_name}" if self.gpu_count > 1 else self.gpu_name,
            "vram_gb": self.vram_gb,
            "vcpus": self.vcpus,
            "ram_gb": self.ram_gb,
            "price_per_hour": round(self.price_per_hour, 4),
            "stoppable": self.stoppable,
            "label": self.label,
            "price_source": self.price_source,
            "price_as_of": self.price_as_of.isoformat(),
        }


SNAPSHOT: tuple[Offer, ...] = (
    Offer("g4dn.xlarge", "aws", "T4", 1, 16, 4, 16, 0.6312, True, 7, True, "Starter GPU"),
    Offer("n1-standard-4:nvidia-tesla-t4:1", "gcp", "T4", 1, 16, 4, 15, 0.648, True, 7, True, "Starter GPU"),
    Offer("g2-standard-4:nvidia-l4:1", "gcp", "L4", 1, 24, 4, 16, 0.8454, True, 7, True, "Creator"),
    Offer("g2-standard-8:nvidia-l4:1", "gcp", "L4", 1, 24, 8, 32, 1.0243, True, 7, True, "Creator Plus"),
    Offer("g5.xlarge", "aws", "A10G", 1, 24, 4, 16, 1.2072, True, 7, True, "Performance"),
    Offer("l40s-48gb.1x", "crusoe", "L40S", 1, 48, 8, 147, 1.74, True, 7, False, "Large model"),
)


class Catalog:
    """Snapshot catalog with an optional live-price overlay."""

    def __init__(self, offers: tuple[Offer, ...] = SNAPSHOT, ttl_seconds: int = 600):
        self._offers = {o.type: o for o in offers}
        self._ttl = ttl_seconds
        self._refreshed_at = 0.0

    def offers(self) -> list[Offer]:
        return list(self._offers.values())

    def get(self, instance_type: str) -> Offer | None:
        return self._offers.get(instance_type)

    def mark_checked(self) -> None:
        """Record a refresh attempt so a failing CLI isn't retried on every request."""
        self._refreshed_at = time.monotonic()

    @property
    def stale(self) -> bool:
        return time.monotonic() - self._refreshed_at > self._ttl

    def apply_live(self, search_json: str) -> int:
        """Overlay prices from `brev search gpu --json`. Returns entries updated.

        Only types already in the catalog are touched; Brev cannot widen what we
        are willing to provision.
        """
        try:
            rows = json.loads(search_json)
        except json.JSONDecodeError:
            log.warning("catalog.live_parse_failed")
            return 0
        if isinstance(rows, dict):
            rows = rows.get("items") or rows.get("instances") or []
        now = datetime.now(UTC)
        updated = 0
        for row in rows:
            offer = self._offers.get(row.get("type", ""))
            price = row.get("price_per_hour")
            if offer is None or not isinstance(price, int | float) or price <= 0:
                continue
            self._offers[offer.type] = replace(
                offer,
                price_per_hour=float(price),
                stoppable=bool(row.get("stoppable", offer.stoppable)),
                price_source="live",
                price_as_of=now,
            )
            updated += 1
        self._refreshed_at = time.monotonic()
        return updated
