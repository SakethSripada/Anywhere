"""SpacetimeDB access for the control plane.

There is no maintained Python SDK, so we use the documented HTTP API:
  * reducers:  POST /v1/database/{db}/call/{reducer}   (JSON array of args)
  * reads:     POST /v1/database/{db}/sql               (SELECT * FROM <view>)
  * identity:  POST /v1/identity, GET /v1/identity/{id}/verify

The service authenticates as an allowlisted *worker* identity. It reads state
through `worker_*` views, which the module only populates for workers.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
import structlog

log = structlog.get_logger()


class SpacetimeError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class ReducerRejected(SpacetimeError):
    """The module refused the call (a SenderError). Not retryable."""


# ── SATS-JSON helpers ───────────────────────────────────────────────────────


def identity_arg(hex_identity: str) -> dict:
    return {"__identity__": "0x" + hex_identity.removeprefix("0x")}


def _identity_hex(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("__identity__", next(iter(value.values()), ""))
    if isinstance(value, list):
        value = value[0]
    if isinstance(value, int):
        return f"{value:064x}"
    return str(value).removeprefix("0x").lower()


def _micros(value: Any) -> int:
    if isinstance(value, dict):
        value = next(iter(value.values()))
    if isinstance(value, list):
        value = value[0]
    return int(value)


def decode(value: Any, ty: dict) -> Any:
    """Decode one SATS-JSON value given its JSON-encoded AlgebraicType."""
    if "Product" in ty:
        elements = ty["Product"]["elements"]
        names = [_name(e) for e in elements]
        if names == ["__identity__"]:
            return _identity_hex(value)
        if names == ["__connection_id__"]:
            return value
        if names == ["__timestamp_micros_since_unix_epoch__"]:
            return datetime.fromtimestamp(_micros(value) / 1e6, tz=UTC)
        if names == ["__time_duration_micros__"]:
            return _micros(value)
        if isinstance(value, dict):
            return {n: decode(value.get(n), e["algebraic_type"]) for n, e in zip(names, elements, strict=True)}
        return {n: decode(v, e["algebraic_type"]) for n, v, e in zip(names, value, elements, strict=True)}
    if "Sum" in ty:
        variants = ty["Sum"]["variants"]
        names = [_name(v) for v in variants]
        tag, inner = next(iter(value.items()))
        idx = int(tag) if str(tag).isdigit() else names.index(tag)
        if names == ["some", "none"]:
            return None if idx == 1 else decode(inner, variants[0]["algebraic_type"])
        return {"tag": names[idx], "value": decode(inner, variants[idx]["algebraic_type"])}
    if "Array" in ty:
        return [decode(v, ty["Array"]) for v in value]
    return value


def _name(element: dict) -> str | None:
    name = element.get("name")
    if isinstance(name, dict):
        return name.get("some")
    return name


# ── Client ──────────────────────────────────────────────────────────────────


@dataclass
class SpacetimeClient:
    host: str
    database: str
    token: str | None = None
    timeout: float = 15.0

    def __post_init__(self) -> None:
        self._http = httpx.AsyncClient(base_url=self.host.rstrip("/"), timeout=self.timeout)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    async def close(self) -> None:
        await self._http.aclose()

    async def call(self, reducer: str, *args: Any, retries: int = 3) -> None:
        """Invoke a reducer. Retries transport failures; never retries rejections."""
        url = f"/v1/database/{self.database}/call/{reducer}"
        body = json.dumps(list(args), default=_json_default)
        for attempt in range(retries):
            try:
                res = await self._http.post(
                    url, content=body, headers={**self._headers(), "Content-Type": "application/json"}
                )
            except httpx.TransportError as exc:
                if attempt == retries - 1:
                    raise SpacetimeError(f"{reducer}: {exc}") from exc
                await asyncio.sleep(0.4 * 2**attempt)
                continue
            if res.status_code < 300:
                return
            text = res.text.strip()
            if res.status_code in (400, 530) or "SenderError" in text:
                raise ReducerRejected(f"{reducer} rejected: {text}", res.status_code)
            if res.status_code >= 500 and attempt < retries - 1:
                await asyncio.sleep(0.4 * 2**attempt)
                continue
            raise SpacetimeError(f"{reducer} failed ({res.status_code}): {text}", res.status_code)

    async def sql(self, query: str) -> list[dict]:
        res = await self._http.post(f"/v1/database/{self.database}/sql", content=query, headers=self._headers())
        if res.status_code >= 300:
            raise SpacetimeError(f"sql failed ({res.status_code}): {res.text}", res.status_code)
        statements = res.json()
        if not statements:
            return []
        stmt = statements[0]
        ty = {"Product": stmt["schema"]}
        return [decode(row, ty) for row in stmt["rows"]]

    async def create_identity(self) -> tuple[str, str]:
        res = await self._http.post("/v1/identity")
        res.raise_for_status()
        data = res.json()
        return _identity_hex(data["identity"]), data["token"]

    async def verify(self, identity_hex: str, token: str) -> bool:
        res = await self._http.get(
            f"/v1/identity/0x{identity_hex}/verify", headers={"Authorization": f"Bearer {token}"}
        )
        return res.status_code < 300


def _json_default(value: Any) -> Any:
    if isinstance(value, datetime):
        return {"__timestamp_micros_since_unix_epoch__": int(value.timestamp() * 1e6)}
    raise TypeError(f"Cannot encode {type(value).__name__}")
