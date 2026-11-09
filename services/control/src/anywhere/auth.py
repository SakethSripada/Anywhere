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
from collections import OrderedDict

import structlog
from fastapi import Depends, Header, HTTPException, Request

from .stdb import SpacetimeClient

log = structlog.get_logger()

_CACHE_TTL = 300
#: Bounded: every distinct token used to stay in here for the life of the process.
_CACHE_MAX = 4096
_cache: OrderedDict[str, tuple[str, float]] = OrderedDict()

#: A bridge secret shorter than this is refused (fail closed); `openssl rand -hex 32` makes one.
MIN_BRIDGE_SECRET = 32


def _claims(token: str) -> dict:
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))
    except (IndexError, ValueError) as exc:
        raise HTTPException(401, "Malformed token") from exc


async def verify_token(stdb: SpacetimeClient, token: str, claimed: str | None = None) -> str:
    digest = hashlib.sha256(f"{claimed}:{token}".encode()).hexdigest()
    now = time.monotonic()
    if hit := _cache.get(digest):
        if hit[1] > now:
            return hit[0]
        del _cache[digest]
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
    _remember(digest, identity, now)
    return identity


def _remember(digest: str, identity: str, now: float) -> None:
    _cache[digest] = (identity, now + _CACHE_TTL)
    _cache.move_to_end(digest)
    # Entries are inserted in expiry order, so expired ones sit at the front.
    while _cache and (len(_cache) > _CACHE_MAX or next(iter(_cache.values()))[1] <= now):
        _cache.popitem(last=False)


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
    if secret and len(secret.get_secret_value()) < MIN_BRIDGE_SECRET:
        # Fail closed: a guessable secret would let anyone act as any linked phone.
        log.error("bridge.secret_too_short", min_length=MIN_BRIDGE_SECRET, hint="openssl rand -hex 32")
        raise HTTPException(503, "Bridge is misconfigured")
    if (
        not secret
        or not x_bridge_secret
        or not hmac.compare_digest(secret.get_secret_value().encode(), x_bridge_secret.encode())
    ):
        raise HTTPException(401, "Invalid bridge credentials")


Identity = Depends(current_identity)
