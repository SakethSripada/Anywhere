"""Control-plane-only state: per-workload secrets and accounting bookkeeping.

Kept out of SpacetimeDB on purpose — users can read their own workload rows,
and the desktop agent token is a machine credential they should never see.
A small JSON file (0600) is enough for one control-plane instance.
"""

from __future__ import annotations

import json
import os
import secrets
import threading
from pathlib import Path
from typing import Any


class Vault:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        self._data: dict[str, Any] = json.loads(path.read_text()) if path.exists() else {}

    def _flush(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._data, indent=2))
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)

    def get(self, workload_id: int) -> dict[str, Any]:
        with self._lock:
            return dict(self._data.get("workloads", {}).get(str(workload_id), {}))

    def update(self, workload_id: int, **values: Any) -> dict[str, Any]:
        with self._lock:
            entry = self._data.setdefault("workloads", {}).setdefault(str(workload_id), {})
            entry.update(values)
            self._flush()
            return dict(entry)

    def agent_token(self, workload_id: int) -> str:
        token = self.get(workload_id).get("cua_token")
        if not token:
            token = secrets.token_hex(24)
            self.update(workload_id, cua_token=token)
        return token

    # Uploads are registered here until a workload consumes them.
    def put_upload(self, upload_id: int, record: dict[str, Any]) -> None:
        with self._lock:
            self._data.setdefault("uploads", {})[str(upload_id)] = record
            self._flush()

    def upload(self, upload_id: int) -> dict[str, Any] | None:
        with self._lock:
            return self._data.get("uploads", {}).get(str(upload_id))

    # MCP access tokens, keyed by the SHA-256 of the secret. The secret itself is never stored.
    def put_mcp_token(self, digest: str, record: dict[str, Any]) -> None:
        with self._lock:
            self._data.setdefault("mcp_tokens", {})[digest] = record
            self._flush()

    def mcp_token(self, digest: str) -> dict[str, Any] | None:
        with self._lock:
            record = self._data.get("mcp_tokens", {}).get(digest)
            return dict(record) if record else None

    def mcp_tokens_for(self, owner: str) -> list[dict[str, Any]]:
        """Personal tokens only; OAuth access tokens are listed through their grant."""
        with self._lock:
            return [
                dict(r)
                for r in self._data.get("mcp_tokens", {}).values()
                if r["owner"] == owner and r.get("grant_id") is None
            ]

    def update_mcp_token(self, digest: str, **values: Any) -> None:
        with self._lock:
            record = self._data.get("mcp_tokens", {}).get(digest)
            if record:
                record.update(values)
                self._flush()

    def delete_mcp_token(self, owner: str, token_id: int) -> bool:
        with self._lock:
            tokens = self._data.get("mcp_tokens", {})
            digest = next((d for d, r in tokens.items() if r["owner"] == owner and r["id"] == token_id), None)
            if digest is None:
                return False
            del tokens[digest]
            self._flush()
            return True

    # Small keyed sections for OAuth state (clients, pending requests, codes, grants, refresh tokens).
    def section_get(self, section: str, key: str) -> dict[str, Any] | None:
        with self._lock:
            record = self._data.get(section, {}).get(key)
            return dict(record) if record else None

    def section_put(self, section: str, key: str, record: dict[str, Any]) -> None:
        with self._lock:
            self._data.setdefault(section, {})[key] = record
            self._flush()

    def section_pop(self, section: str, key: str) -> dict[str, Any] | None:
        with self._lock:
            record = self._data.get(section, {}).pop(key, None)
            if record is not None:
                self._flush()
            return record

    def section_items(self, section: str) -> list[tuple[str, dict[str, Any]]]:
        with self._lock:
            return [(k, dict(v)) for k, v in self._data.get(section, {}).items()]

    def section_size(self, section: str) -> int:
        with self._lock:
            return len(self._data.get(section, {}))

    def drop_grant(self, grant_id: int) -> bool:
        """Remove an OAuth grant and every token issued under it."""
        with self._lock:
            found = self._data.get("oauth_grants", {}).pop(str(grant_id), None) is not None
            for section in ("mcp_tokens", "oauth_refresh", "oauth_codes"):
                entries = self._data.get(section, {})
                for key in [k for k, v in entries.items() if v.get("grant_id") == grant_id]:
                    del entries[key]
            self._flush()
            return found

    def purge_expired(self, now_iso: str, now_ts: float) -> None:
        """Drop expired OAuth codes, requests, refresh tokens and access tokens."""
        with self._lock:
            changed = False
            for section, field, value in (
                ("oauth_requests", "expires_ts", now_ts),
                ("oauth_codes", "expires_ts", now_ts),
                ("oauth_refresh", "expires_ts", now_ts),
            ):
                entries = self._data.get(section, {})
                for key in [k for k, v in entries.items() if v.get(field, 0) <= value]:
                    del entries[key]
                    changed = True
            tokens = self._data.get("mcp_tokens", {})
            for key in [k for k, v in tokens.items() if v.get("grant_id") and v["expires_at"] <= now_iso]:
                del tokens[key]
                changed = True
            if changed:
                self._flush()
