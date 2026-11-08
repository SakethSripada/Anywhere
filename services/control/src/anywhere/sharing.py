"""Watch-only share links for a desktop.

A link carries a random token; only its SHA-256 is stored, so the vault never holds
something that grants access. One link per desktop: making a new one replaces the
old. Links expire, and revoking one also disconnects anyone watching through it.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta

SECTION = "shares"
MAX_HOURS = 24


def digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_token() -> str:
    return secrets.token_urlsafe(24)


def make(workload_id: int, owner: str, hours: float, now: datetime | None = None) -> tuple[str, dict]:
    now = now or datetime.now(UTC)
    hours = min(max(hours, 0.25), MAX_HOURS)
    token = new_token()
    return token, {
        "workload_id": int(workload_id),
        "owner": owner,
        "created_at": now.isoformat(),
        "expires_at": (now + timedelta(hours=hours)).isoformat(),
    }


def live(rec: dict | None, now: datetime | None = None) -> bool:
    now = now or datetime.now(UTC)
    return bool(rec) and datetime.fromisoformat(rec["expires_at"]) > now


def seconds_left(rec: dict, now: datetime | None = None) -> float:
    now = now or datetime.now(UTC)
    return max(0.0, (datetime.fromisoformat(rec["expires_at"]) - now).total_seconds())
