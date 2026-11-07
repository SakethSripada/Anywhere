"""Photon Spectrum management API (allowlisting users on shared iMessage lines).

Message transport itself lives in services/messaging (spectrum-ts is the only
SDK that can send). On Free/Pro plans a shared line only talks to allowlisted
numbers, so linking a phone in Anywhere registers it here first.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import quote

import httpx

from .config import Settings

E164 = re.compile(r"^\+[1-9]\d{6,14}$")


class PhotonError(Exception):
    pass


@dataclass(frozen=True)
class LineAssignment:
    user_id: str
    assigned_number: str | None

    def deep_link(self, base: str, message: str) -> str:
        return f"{base}/users/{self.user_id}/redirect?msg={quote(message)}"


def normalize_phone(raw: str) -> str:
    digits = re.sub(r"[^\d+]", "", raw.strip())
    if not digits.startswith("+"):
        digits = "+1" + digits if len(digits) == 10 else "+" + digits
    if not E164.match(digits):
        raise PhotonError("Enter a phone number in international format, e.g. +1 555 010 0199")
    return digits


class PhotonClient:
    def __init__(self, settings: Settings):
        if not settings.photon_ready:
            raise PhotonError("Photon is not configured")
        self.base = settings.spectrum_api_base.rstrip("/")
        self.project = settings.spectrum_project_id
        self._auth = (settings.spectrum_project_id, settings.spectrum_project_secret.get_secret_value())

    async def allowlist(self, phone: str) -> LineAssignment:
        async with httpx.AsyncClient(base_url=self.base, auth=self._auth, timeout=15) as http:
            res = await http.post(f"/projects/{self.project}/users/", json={"type": "shared", "phoneNumber": phone})
            if res.status_code < 300:
                return _assignment(res.json().get("data", {}))
            if res.status_code not in (400, 409, 422):
                raise PhotonError(f"Photon rejected the number ({res.status_code})")
            # Already registered: find the existing assignment.
            listing = await http.get(f"/projects/{self.project}/users/")
            listing.raise_for_status()
            rows = listing.json().get("data", [])
            rows = rows.get("items", rows) if isinstance(rows, dict) else rows
            for row in rows:
                if row.get("phoneNumber") == phone:
                    return _assignment(row)
            raise PhotonError(f"Photon could not register this number: {res.text[:200]}")


def _assignment(data: dict) -> LineAssignment:
    if not data.get("id"):
        raise PhotonError("Photon returned no user id")
    return LineAssignment(user_id=data["id"], assigned_number=data.get("assignedPhoneNumber"))
