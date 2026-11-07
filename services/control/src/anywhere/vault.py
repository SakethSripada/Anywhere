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
