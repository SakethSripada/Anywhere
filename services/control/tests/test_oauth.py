"""OAuth sign-in for MCP clients, end to end over HTTP: discovery, registration, PKCE, consent, refresh, revocation."""

import base64
import hashlib
import secrets
from contextlib import asynccontextmanager
from urllib.parse import parse_qs, urlparse

import httpx2
import pytest

from anywhere.auth import current_identity

from .test_mcp import ALICE, BASE, BOB, Harness, account, data, text

REDIRECT = "http://localhost:33418/callback"
ISSUER = "http://localhost:8010"


@pytest.fixture
def h(tmp_path, monkeypatch):
    return Harness(tmp_path, monkeypatch, public_api_url=ISSUER)


@asynccontextmanager
async def http(h, owner=ALICE):
    """One client for everything: OAuth endpoints, and browser calls made as `owner`."""
    h.api.dependency_overrides[current_identity] = lambda: owner
    async with h.running(), httpx2.AsyncClient(transport=httpx2.ASGITransport(app=h.api), base_url=BASE) as c:
        yield c


def pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    return verifier, challenge


async def register(c, redirect=REDIRECT) -> str:
    res = await c.post(
        "/register",
        json={"redirect_uris": [redirect], "client_name": "Claude", "token_endpoint_auth_method": "none"},
    )
    assert res.status_code == 201, res.text
    return res.json()["client_id"]


async def start(h, c, client_id, challenge, scope="read plan control spend") -> str:
    res = await c.get(
        "/authorize",
        params={
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": REDIRECT,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": "st4te",
            "scope": scope,
        },
    )
    assert res.status_code == 302, res.text
    target = urlparse(res.headers["location"])
    web = h.app.settings.public_web_origin
    assert f"{target.scheme}://{target.netloc}{target.path}" == f"{web}/connect", res.headers["location"]
    return parse_qs(target.query)["request"][0]


async def approve(c, request_id, scopes=None) -> str:
    res = await c.post(f"/v1/oauth/requests/{request_id}/decision", json={"approve": True, "scopes": scopes})
    assert res.status_code == 200, res.text
    query = parse_qs(urlparse(res.json()["redirect"]).query)
    assert query["state"] == ["st4te"]
    return query["code"][0]


async def exchange(c, client_id, code, verifier):
    return await c.post(
        "/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT,
            "client_id": client_id,
            "code_verifier": verifier,
        },
    )


async def sign_in(h, c, scopes=None):
    client_id = await register(c)
    verifier, challenge = pkce()
    code = await approve(c, await start(h, c, client_id, challenge), scopes)
    res = await exchange(c, client_id, code, verifier)
    assert res.status_code == 200, res.text
    return client_id, res.json()


# ── Discovery ───────────────────────────────────────────────────────────────


async def test_clients_can_discover_how_to_sign_in(h):
    async with http(h) as c:
        challenge = (await c.post("/mcp", json={})).headers["www-authenticate"]
        assert f'resource_metadata="{ISSUER}/.well-known/oauth-protected-resource/mcp"' in challenge
        resource = (await c.get("/.well-known/oauth-protected-resource/mcp")).json()
        assert resource["resource"] == f"{ISSUER}/mcp"
        assert resource["authorization_servers"] == [ISSUER]
        meta = (await c.get("/.well-known/oauth-authorization-server")).json()
    assert meta["issuer"] == ISSUER and meta["authorization_endpoint"] == f"{ISSUER}/authorize"
    assert meta["code_challenge_methods_supported"] == ["S256"]
    assert set(meta["scopes_supported"]) == {"read", "plan", "control", "spend"}


async def test_issuer_behind_a_path_prefix(tmp_path, monkeypatch):
    # Production: Caddy serves the control plane at https://host/api.
    h = Harness(tmp_path, monkeypatch, public_api_url="https://anywhere.example/api")
    async with http(h) as c:
        for path in ("/.well-known/oauth-authorization-server/api", "/.well-known/oauth-authorization-server"):
            meta = (await c.get(path)).json()
            assert meta["token_endpoint"] == "https://anywhere.example/api/token", path
        resource = (await c.get("/.well-known/oauth-protected-resource/api/mcp")).json()
        assert resource["resource"] == "https://anywhere.example/api/mcp"


async def test_insecure_public_url_disables_oauth_but_not_the_service(tmp_path, monkeypatch):
    h = Harness(tmp_path, monkeypatch, public_api_url="http://203.0.113.7/api")
    token = h.token()
    async with http(h) as c:
        assert (await c.get("/.well-known/oauth-authorization-server")).status_code == 404
        assert "resource_metadata" not in (await c.post("/mcp", json={})).headers["www-authenticate"]
    async with h.running(), h.client(token) as m:
        assert not (await m.call_tool("get_catalog", {})).is_error


# ── Registration and authorization ──────────────────────────────────────────


async def test_registration_only_accepts_safe_redirects(h):
    async with http(h) as c:
        for uri in ("http://evil.example/cb", "javascript:alert(1)", "https://ok.example/cb#frag"):
            res = await c.post("/register", json={"redirect_uris": [uri], "token_endpoint_auth_method": "none"})
            assert res.status_code == 400, uri
        for uri in ("https://claude.ai/api/mcp/auth_callback", "http://127.0.0.1:5555/cb", REDIRECT):
            assert (
                await c.post("/register", json={"redirect_uris": [uri], "token_endpoint_auth_method": "none"})
            ).status_code == 201


async def test_full_sign_in_with_narrowed_permissions(h):
    async with http(h) as c:
        client_id = await register(c)
        verifier, challenge = pkce()
        request_id = await start(h, c, client_id, challenge)
        shown = (await c.get(f"/v1/oauth/requests/{request_id}")).json()
        assert shown["client_name"] == "Claude" and shown["redirect_host"] == "localhost:33418"
        assert shown["scopes"] == ["control", "plan", "read", "spend"]
        # The user unticks spend; the client can't get it back.
        code = await approve(c, request_id, ["read", "plan", "admin"])
        res = await exchange(c, client_id, code, verifier)
        assert res.status_code == 200, res.text
        tokens = res.json()
        assert tokens["scope"] == "plan read" and tokens["expires_in"] == 3600
        # Codes are single use, and PKCE has to match.
        assert (await exchange(c, client_id, code, verifier)).status_code == 400

    async with h.client(tokens["access_token"]) as m:
        acct = data(await m.call_tool("get_account", {}))
        assert acct["token_permissions"] == ["plan", "read"]
        blocked = await m.call_tool("approve_workload", {"workload_id": 1})
        assert blocked.is_error and "'spend' permission" in text(blocked)

    # Personal-token lists stay clean; the connection is listed on its own.
    async with http(h) as c:
        assert (await c.get("/v1/mcp/tokens")).json()["tokens"] == []
        (grant,) = (await c.get("/v1/oauth/grants")).json()["grants"]
        assert grant["client_name"] == "Claude" and grant["last_used_at"]


async def test_wrong_pkce_verifier_is_refused(h):
    async with http(h) as c:
        client_id = await register(c)
        _, challenge = pkce()
        code = await approve(c, await start(h, c, client_id, challenge))
        assert (await exchange(c, client_id, code, "not-the-verifier-" + "x" * 40)).status_code == 400


async def test_denying_sends_the_user_back_with_an_error(h):
    async with http(h) as c:
        client_id = await register(c)
        request_id = await start(h, c, client_id, pkce()[1])
        res = await c.post(f"/v1/oauth/requests/{request_id}/decision", json={"approve": False})
        query = parse_qs(urlparse(res.json()["redirect"]).query)
        assert query["error"] == ["access_denied"] and query["state"] == ["st4te"]
        # Requests are single use either way.
        assert (await c.get(f"/v1/oauth/requests/{request_id}")).status_code == 404
        assert (await c.post(f"/v1/oauth/requests/{request_id}/decision", json={"approve": True})).status_code == 404


async def test_unknown_scopes_and_inactive_accounts_are_refused(h):
    h.store.accounts_ = [account(ALICE), account(BOB, activated=False)]
    async with http(h, BOB) as c:
        client_id = await register(c)
        res = await c.get(
            "/authorize",
            params={
                "response_type": "code",
                "client_id": client_id,
                "redirect_uri": REDIRECT,
                "code_challenge": pkce()[1],
                "code_challenge_method": "S256",
                "scope": "read admin",
            },
        )
        assert "invalid_scope" in res.headers.get("location", res.text)
        request_id = await start(h, c, client_id, pkce()[1])
        assert (await c.post(f"/v1/oauth/requests/{request_id}/decision", json={"approve": True})).status_code == 409


# ── Refresh and revocation ──────────────────────────────────────────────────


async def refresh(c, client_id, token):
    return await c.post("/token", data={"grant_type": "refresh_token", "refresh_token": token, "client_id": client_id})


async def test_refresh_tokens_rotate(h):
    async with http(h) as c:
        client_id, first = await sign_in(h, c)
        second = await refresh(c, client_id, first["refresh_token"])
        assert second.status_code == 200, second.text
        assert second.json()["access_token"] != first["access_token"]
        assert (await refresh(c, client_id, first["refresh_token"])).status_code == 400
        # Another client can't use this client's refresh token.
        other = await register(c)
        assert (await refresh(c, other, second.json()["refresh_token"])).status_code == 400
    async with h.client(second.json()["access_token"]) as m:
        assert not (await m.call_tool("get_catalog", {})).is_error


async def test_revoking_a_connection_cuts_off_its_tokens(h):
    async with http(h) as c:
        client_id, tokens = await sign_in(h, c)
        (grant,) = (await c.get("/v1/oauth/grants")).json()["grants"]
        assert (
            await c.post("/mcp", headers={"Authorization": f"Bearer {tokens['access_token']}"}, json={})
        ).status_code != 401
        assert (await c.delete(f"/v1/oauth/grants/{grant['id']}")).status_code == 200
        assert (
            await c.post("/mcp", headers={"Authorization": f"Bearer {tokens['access_token']}"}, json={})
        ).status_code == 401
        assert (await refresh(c, client_id, tokens["refresh_token"])).status_code == 400
        assert (await c.delete(f"/v1/oauth/grants/{grant['id']}")).status_code == 404


async def test_users_cannot_revoke_each_others_connections(h):
    async with http(h, BOB) as c:
        await sign_in(h, c)
        (grant,) = (await c.get("/v1/oauth/grants")).json()["grants"]
    async with http(h, ALICE) as c:
        assert (await c.get("/v1/oauth/grants")).json()["grants"] == []
        assert (await c.delete(f"/v1/oauth/grants/{grant['id']}")).status_code == 404


async def test_oauth_revocation_endpoint(h):
    async with http(h) as c:
        client_id, tokens = await sign_in(h, c)
        # The SDK requires the client_secret field even for public clients, so send it empty.
        res = await c.post(
            "/revoke", data={"token": tokens["refresh_token"], "client_id": client_id, "client_secret": ""}
        )
        assert res.status_code == 200, res.text
        assert (await c.get("/v1/oauth/grants")).json()["grants"] == []
        assert (
            await c.post("/mcp", headers={"Authorization": f"Bearer {tokens['access_token']}"}, json={})
        ).status_code == 401


async def test_oauth_connections_share_one_conversation(h):
    async with http(h) as c:
        client_id, first = await sign_in(h, c)
        second = (await refresh(c, client_id, first["refresh_token"])).json()
    for token in (first["access_token"], second["access_token"]):
        async with h.client(token) as m:
            assert not (
                await m.call_tool("propose_workload", {"request": {"kind": "desktop", "summary": "A VS Code desktop"}})
            ).is_error
    assert len(h.store.conversations) == 1
