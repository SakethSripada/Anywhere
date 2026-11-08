"""OAuth 2.1 for the MCP server, so clients like claude.ai can connect with a browser sign-in
instead of a pasted token.

The SDK provides the protocol endpoints (metadata, dynamic client registration, /authorize,
/token with PKCE, /revoke); this module is the storage and policy behind them. Anywhere has
no passwords: "signing in" is approving the request on the web app's /connect page, where the
browser already holds its SpacetimeDB identity. Approving creates a *grant* for that account.
Access tokens are ordinary MCP tokens tied to the grant (1 hour), refresh tokens rotate
(30 days), and revoking the grant in Settings kills both.

Every secret (codes, access and refresh tokens) is stored as a SHA-256 hash in the vault.
"""

from __future__ import annotations

import secrets
import time
from datetime import UTC, datetime, timedelta
from ipaddress import ip_address
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

import structlog
from fastapi import HTTPException
from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    AuthorizeError,
    RefreshToken,
    RegistrationError,
    TokenError,
    construct_redirect_uri,
)
from mcp.server.auth.routes import create_auth_routes, create_protected_resource_routes
from mcp.server.auth.settings import ClientRegistrationOptions, RevocationOptions
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from pydantic import AnyHttpUrl, BaseModel, ConfigDict
from starlette.routing import Route

from .ids import new_id
from .mcp_server import DEFAULT_SCOPES, SCOPES, TOKEN_PREFIX, authenticate, digest

if TYPE_CHECKING:
    from fastapi import FastAPI

    from .core import Anywhere
    from .vault import Vault

log = structlog.get_logger()

ACCESS_TTL = 3600
REFRESH_TTL = 30 * 86400
CODE_TTL = 300
REQUEST_TTL = 600
REFRESH_PREFIX = "awmcpr_"
MAX_CLIENTS = 1000


class Code(AuthorizationCode):
    grant_id: int


class Refresh(RefreshToken):
    grant_id: int


def _now() -> datetime:
    return datetime.now(UTC)


def _safe_redirect(uri: str) -> bool:
    """HTTPS anywhere, or plain HTTP only back to this machine (native and CLI clients)."""
    parsed = urlparse(uri)
    if parsed.fragment:
        return False
    if parsed.scheme == "https":
        return bool(parsed.netloc)
    if parsed.scheme != "http" or not parsed.hostname:
        return False
    if parsed.hostname == "localhost":
        return True
    try:
        return ip_address(parsed.hostname).is_loopback
    except ValueError:
        return False


class AnywhereOAuth:
    """`OAuthAuthorizationServerProvider` backed by the control plane's vault."""

    def __init__(self, api: FastAPI):
        self.api = api

    @property
    def app(self) -> Anywhere:
        return self.api.state.anywhere

    @property
    def vault(self) -> Vault:
        return self.app.vault

    # ── Clients ─────────────────────────────────────────────────────────

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        record = self.vault.section_get("oauth_clients", client_id[:128])
        return OAuthClientInformationFull.model_validate(record) if record else None

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        from .api import rate_limit

        try:
            rate_limit("oauth-register", 30)
        except HTTPException as exc:
            raise RegistrationError("invalid_client_metadata", "Too many registrations; try again shortly") from exc
        if self.vault.section_size("oauth_clients") >= MAX_CLIENTS:
            raise RegistrationError("invalid_client_metadata", "This server can't register more clients")
        uris = [str(u) for u in client_info.redirect_uris or []]
        if not uris or not all(_safe_redirect(u) for u in uris):
            raise RegistrationError("invalid_redirect_uri", "Redirect URIs must be HTTPS or loopback HTTP")
        name = (client_info.client_name or "").strip()[:60] or "An MCP client"
        info = client_info.model_copy(update={"client_name": name})
        self.vault.section_put("oauth_clients", info.client_id, info.model_dump(mode="json", exclude_none=True))
        log.info("oauth.client_registered", client=info.client_id, name=name)

    # ── Authorization ───────────────────────────────────────────────────

    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        scopes = params.scopes or list(DEFAULT_SCOPES)
        if unknown := set(scopes) - SCOPES.keys():
            raise AuthorizeError("invalid_scope", f"Unknown scope: {', '.join(sorted(unknown))}")
        if params.resource and params.resource.rstrip("/") != self.resource_url.rstrip("/"):
            raise AuthorizeError("invalid_target", "Tokens can only be issued for this Anywhere server")
        self._purge()
        request_id = secrets.token_urlsafe(24)
        self.vault.section_put(
            "oauth_requests",
            request_id,
            {
                "client_id": client.client_id,
                "client_name": client.client_name or "An MCP client",
                "scopes": sorted(set(scopes)),
                "state": params.state,
                "code_challenge": params.code_challenge,
                "redirect_uri": str(params.redirect_uri),
                "explicit": params.redirect_uri_provided_explicitly,
                "resource": params.resource,
                "expires_ts": time.time() + REQUEST_TTL,
            },
        )
        origin = self.app.settings.public_web_origin.rstrip("/")
        return f"{origin}/connect?request={request_id}"

    def pending(self, request_id: str) -> dict | None:
        record = self.vault.section_get("oauth_requests", request_id[:64])
        if not record or record["expires_ts"] <= time.time():
            return None
        return record

    def decide(self, request_id: str, owner: str, approve: bool, scopes: list[str] | None) -> str:
        """Approve or deny a pending request for `owner`. Returns where to send the browser."""
        # Validate before consuming the request: a rejected submission (say, every
        # permission unticked) must leave it in place so the user can fix and retry.
        record = self.vault.section_get("oauth_requests", request_id[:64])
        if not record or record["expires_ts"] <= time.time():
            raise HTTPException(404, "This sign-in request has expired. Start again from your app.")
        if approve:
            requested = set(record["scopes"])
            if not set(scopes if scopes is not None else record["scopes"]) & requested:
                raise HTTPException(422, "Allow at least one permission, or choose Deny")
        if not self.vault.section_pop("oauth_requests", request_id[:64]):
            raise HTTPException(404, "This sign-in request has expired. Start again from your app.")
        if not approve:
            log.info("oauth.denied", client=record["client_id"], owner=owner[:12])
            return construct_redirect_uri(
                record["redirect_uri"],
                error="access_denied",
                error_description="The user declined",
                state=record["state"],
            )
        # The user may narrow what the client asked for, never widen it.
        granted = sorted(set(scopes if scopes is not None else record["scopes"]) & set(record["scopes"]))
        if not granted:
            raise HTTPException(422, "Allow at least one permission, or choose Deny")
        grant_id = new_id()
        self.vault.section_put(
            "oauth_grants",
            str(grant_id),
            {
                "id": grant_id,
                "owner": owner,
                "client_id": record["client_id"],
                "client_name": record["client_name"],
                "scopes": granted,
                "created_at": _now().isoformat(),
                "last_used_at": None,
            },
        )
        code = secrets.token_urlsafe(32)
        self.vault.section_put(
            "oauth_codes",
            digest(code),
            {
                "grant_id": grant_id,
                "client_id": record["client_id"],
                "scopes": granted,
                "code_challenge": record["code_challenge"],
                "redirect_uri": record["redirect_uri"],
                "explicit": record["explicit"],
                "resource": record["resource"],
                "owner": owner,
                "expires_ts": time.time() + CODE_TTL,
            },
        )
        log.info("oauth.approved", client=record["client_id"], owner=owner[:12], scopes=granted)
        return construct_redirect_uri(record["redirect_uri"], code=code, state=record["state"])

    # ── Codes and tokens ────────────────────────────────────────────────

    async def load_authorization_code(self, client: OAuthClientInformationFull, authorization_code: str) -> Code | None:
        r = self.vault.section_get("oauth_codes", digest(authorization_code))
        if not r or r["client_id"] != client.client_id or r["expires_ts"] <= time.time():
            return None
        return Code(
            code=authorization_code,
            scopes=r["scopes"],
            expires_at=r["expires_ts"],
            client_id=r["client_id"],
            code_challenge=r["code_challenge"],
            redirect_uri=r["redirect_uri"],
            redirect_uri_provided_explicitly=r["explicit"],
            resource=r["resource"],
            subject=r["owner"],
            grant_id=r["grant_id"],
        )

    async def exchange_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: Code
    ) -> OAuthToken:
        # Single use: a replayed code finds nothing and fails with invalid_grant.
        if not self.vault.section_pop("oauth_codes", digest(authorization_code.code)):
            raise TokenError("invalid_grant", "Authorization code already used")
        return self._issue(authorization_code.grant_id, authorization_code.scopes, client.client_id)

    async def load_refresh_token(self, client: OAuthClientInformationFull, refresh_token: str) -> Refresh | None:
        if not refresh_token.startswith(REFRESH_PREFIX):
            return None
        r = self.vault.section_get("oauth_refresh", digest(refresh_token))
        if not r or r["client_id"] != client.client_id or r["expires_ts"] <= time.time():
            return None
        if not self.vault.section_get("oauth_grants", str(r["grant_id"])):
            return None
        return Refresh(
            token=refresh_token,
            client_id=r["client_id"],
            scopes=r["scopes"],
            expires_at=int(r["expires_ts"]),
            grant_id=r["grant_id"],
        )

    async def exchange_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: Refresh, scopes: list[str]
    ) -> OAuthToken:
        if not set(scopes) <= set(refresh_token.scopes):
            raise TokenError("invalid_scope", "Refresh can't widen the granted permissions")
        # Rotation: the old refresh token stops working the moment a new one is issued.
        if not self.vault.section_pop("oauth_refresh", digest(refresh_token.token)):
            raise TokenError("invalid_grant", "Refresh token already used")
        return self._issue(refresh_token.grant_id, scopes or refresh_token.scopes, client.client_id)

    async def load_access_token(self, token: str) -> AccessToken | None:
        p = authenticate(self.app, f"Bearer {token}")
        if not p:
            return None
        return AccessToken(token=token, client_id=str(p.token_id), scopes=sorted(p.scopes), subject=p.owner)

    async def revoke_token(self, token: AccessToken | RefreshToken) -> None:
        if isinstance(token, Refresh):
            # Revoking a refresh token ends the whole grant (RFC 7009 §2.1).
            self.vault.drop_grant(token.grant_id)
        else:
            record = self.vault.mcp_token(digest(token.token))
            if record and record.get("grant_id"):
                self.vault.delete_mcp_token(record["owner"], record["id"])

    def _issue(self, grant_id: int, scopes: list[str], client_id: str) -> OAuthToken:
        grant = self.vault.section_get("oauth_grants", str(grant_id))
        if not grant:
            raise TokenError("invalid_grant", "This connection was revoked")
        scopes = sorted(set(scopes) & set(grant["scopes"]))
        self._purge()
        now = _now()
        access = TOKEN_PREFIX + secrets.token_urlsafe(32)
        self.vault.put_mcp_token(
            digest(access),
            {
                "id": new_id(),
                "owner": grant["owner"],
                "name": grant["client_name"],
                "scopes": scopes,
                "hint": access[: len(TOKEN_PREFIX) + 4],
                "created_at": now.isoformat(),
                "expires_at": (now + timedelta(seconds=ACCESS_TTL)).isoformat(),
                "last_used_at": None,
                "conversation_id": grant.get("conversation_id"),
                "grant_id": grant_id,
            },
        )
        refresh = REFRESH_PREFIX + secrets.token_urlsafe(32)
        self.vault.section_put(
            "oauth_refresh",
            digest(refresh),
            {"grant_id": grant_id, "client_id": client_id, "scopes": scopes, "expires_ts": time.time() + REFRESH_TTL},
        )
        return OAuthToken(
            access_token=access,
            token_type="Bearer",
            expires_in=ACCESS_TTL,
            scope=" ".join(scopes),
            refresh_token=refresh,
        )

    def _purge(self) -> None:
        self.vault.purge_expired(_now().isoformat(), time.time())

    # ── URLs ────────────────────────────────────────────────────────────

    @property
    def issuer_url(self) -> str:
        return self.app.settings.public_api_url.rstrip("/")

    @property
    def resource_url(self) -> str:
        return self.issuer_url + "/mcp"


def grants_for(vault: Vault, owner: str) -> list[dict[str, Any]]:
    return sorted(
        (g for _, g in vault.section_items("oauth_grants") if g["owner"] == owner),
        key=lambda g: g["created_at"],
        reverse=True,
    )


class _Url(BaseModel):
    # RFC 8414 compares issuers as exact strings; plain AnyHttpUrl would add a trailing "/".
    model_config = ConfigDict(url_preserve_empty_path=True)
    url: AnyHttpUrl


def _url(value: str) -> AnyHttpUrl:
    return _Url(url=value).url


def routes(api: FastAPI, provider: AnywhereOAuth, public_api_url: str) -> list[Route]:
    """The SDK's OAuth endpoints plus RFC 9728 metadata, at the paths clients will look for.

    Behind Caddy the issuer has a path (`https://host/api`), so discovery happens at
    `/.well-known/oauth-authorization-server/api` on the host root; Caddy forwards
    `/.well-known/oauth-*` here unchanged, and both forms are served.
    """
    issuer = public_api_url.rstrip("/")
    out = create_auth_routes(
        provider,
        issuer_url=_url(issuer),
        # Clients may register for every scope; the user decides on the consent page, where
        # `spend` starts unticked.
        client_registration_options=ClientRegistrationOptions(
            enabled=True, valid_scopes=list(SCOPES), default_scopes=list(SCOPES)
        ),
        revocation_options=RevocationOptions(enabled=True),
    )
    out += create_protected_resource_routes(
        resource_url=_url(issuer + "/mcp"),
        authorization_servers=[_url(issuer)],
        scopes_supported=list(SCOPES),
        resource_name="Anywhere",
    )
    path = urlparse(issuer).path.rstrip("/")
    if path:
        metadata = next(r for r in out if r.path == "/.well-known/oauth-authorization-server")
        out.append(
            Route(f"/.well-known/oauth-authorization-server{path}", metadata.endpoint, methods=["GET", "OPTIONS"])
        )
    return out


def resource_metadata_url(public_api_url: str) -> str:
    parsed = urlparse(public_api_url.rstrip("/") + "/mcp")
    return f"{parsed.scheme}://{parsed.netloc}/.well-known/oauth-protected-resource{parsed.path}"


__all__ = ["AnywhereOAuth", "grants_for", "resource_metadata_url", "routes"]
