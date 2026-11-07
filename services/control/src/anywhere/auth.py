"""Request authentication.

Browsers hold a SpacetimeDB identity token (the same one they use for live
subscriptions). They present it as a bearer token; we read the identity claim
and confirm the pair with SpacetimeDB's /verify endpoint, caching the result
briefly. One identity therefore spans the realtime data plane and this API.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

from fastapi import Depends, Header, HTTPException, Request

from .stdb import SpacetimeClient

_CACHE_TTL = 300
_cache: dict[str, tuple[str, float]] = {}


def _claims(token: str) -> dict:
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))
    except (IndexError, ValueError) as exc:
        raise HTTPException(401, "Malformed token") from exc


async def verify_token(stdb: SpacetimeClient, token: str, claimed: str | None = None) -> str:
    digest = hashlib.sha256(f"{claimed}:{token}".encode()).hexdigest()
    if (hit := _cache.get(digest)) and hit[1] > time.monotonic():
        return hit[0]
    claims = _claims(token)
    # SpacetimeDB-issued tokens carry `hex_identity`; OIDC tokens don't, so the
    # client also sends the identity its SDK reported and /verify checks the pair.
    identity = (claims.get("hex_identity") or claimed or "").removeprefix("0x").lower()
    if len(identity) != 64:
        raise HTTPException(401, "Token has no SpacetimeDB identity")
    if claims.get("exp") and claims["exp"] < time.time():
        raise HTTPException(401, "Token expired")
    if not await stdb.verify(identity, token):
        raise HTTPException(401, "Token rejected by SpacetimeDB")
    _cache[digest] = (identity, time.monotonic() + _CACHE_TTL)
    return identity


async def current_identity(
    request: Request,
    authorization: str | None = Header(None),
    x_anywhere_identity: str | None = Header(None),
) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Sign in required")
    return await verify_token(request.app.state.anywhere.public_stdb, authorization[7:].strip(), x_anywhere_identity)


def require_bridge(request: Request, x_bridge_secret: str | None = Header(None)) -> None:
    secret = request.app.state.anywhere.settings.messaging_bridge_secret
    if not secret or not x_bridge_secret or not hmac.compare_digest(secret.get_secret_value(), x_bridge_secret):
        raise HTTPException(401, "Invalid bridge credentials")


Identity = Depends(current_identity)
