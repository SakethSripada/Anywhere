"""Durable object storage for projects, datasets, checkpoints and artifacts.

Any S3-compatible service works (Cloudflare R2 is the default recommendation:
free egress and a generous free tier). Compute instances never receive storage
credentials: browsers upload with short-lived presigned URLs, and the control
plane streams tarballs between instances and the bucket over SSH.

Key layout:  users/{identity}/projects/{project_id}/snapshot.tar.zst
             users/{identity}/uploads/{upload_id}/{filename}
             users/{identity}/workloads/{workload_id}/{artifact}
"""

from __future__ import annotations

import asyncio
import re
import subprocess
from dataclasses import dataclass
from typing import IO

import boto3
from botocore.config import Config

from .config import Settings

SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


class StorageUnavailable(Exception):
    pass


def safe_filename(name: str) -> str:
    cleaned = SAFE_NAME.sub("_", name.strip()).strip("._")
    return cleaned[:120] or "file"


@dataclass
class Storage:
    settings: Settings

    def __post_init__(self) -> None:
        s = self.settings
        if not s.storage_ready:
            self._client = None
            return
        self._client = boto3.client(
            "s3",
            endpoint_url=s.s3_endpoint_url,
            region_name=s.s3_region,
            aws_access_key_id=s.s3_access_key_id.get_secret_value(),
            aws_secret_access_key=s.s3_secret_access_key.get_secret_value(),
            config=Config(signature_version="s3v4", retries={"max_attempts": 4, "mode": "standard"}),
        )

    @property
    def bucket(self) -> str:
        if not self._client or not self.settings.s3_bucket:
            raise StorageUnavailable("Object storage is not configured")
        return self.settings.s3_bucket

    @property
    def client(self):
        if not self._client:
            raise StorageUnavailable("Object storage is not configured")
        return self._client

    # ── Keys ──────────────────────────────────────────────────────────────
    @staticmethod
    def project_key(owner: str, project_id: int) -> str:
        return f"users/{owner}/projects/{project_id}/snapshot.tar.gz"

    @staticmethod
    def upload_key(owner: str, upload_id: int, filename: str) -> str:
        return f"users/{owner}/uploads/{upload_id}/{safe_filename(filename)}"

    @staticmethod
    def artifact_key(owner: str, workload_id: int, name: str) -> str:
        return f"users/{owner}/workloads/{workload_id}/{safe_filename(name)}"

    @staticmethod
    def owns(owner: str, key: str) -> bool:
        return key.startswith(f"users/{owner}/") and ".." not in key

    # ── Presigning ────────────────────────────────────────────────────────
    def presign_put(self, key: str, content_type: str, expires: int = 900) -> str:
        return self.client.generate_presigned_url(
            "put_object",
            Params={"Bucket": self.bucket, "Key": key, "ContentType": content_type},
            ExpiresIn=expires,
        )

    def presign_get(self, key: str, expires: int = 900, filename: str | None = None) -> str:
        params = {"Bucket": self.bucket, "Key": key}
        if filename:
            params["ResponseContentDisposition"] = f'attachment; filename="{safe_filename(filename)}"'
        return self.client.generate_presigned_url("get_object", Params=params, ExpiresIn=expires)

    async def head(self, key: str) -> dict | None:
        def _head():
            try:
                return self.client.head_object(Bucket=self.bucket, Key=key)
            except self.client.exceptions.ClientError:
                return None

        return await asyncio.to_thread(_head)

    # ── Streaming ─────────────────────────────────────────────────────────
    async def upload_stream(self, proc: subprocess.Popen, key: str, content_type: str) -> int:
        """Upload a process's stdout (e.g. a remote `tar czf -`) as one object."""

        def _upload() -> int:
            assert proc.stdout is not None
            counter = _CountingReader(proc.stdout)
            self.client.upload_fileobj(counter, self.bucket, key, ExtraArgs={"ContentType": content_type})
            code = proc.wait(timeout=60)
            if code != 0:
                err = proc.stderr.read().decode(errors="replace") if proc.stderr else ""
                raise RuntimeError(f"source process exited {code}: {err[-400:]}")
            return counter.count

        return await asyncio.to_thread(_upload)

    async def download_stream(self, key: str, proc: subprocess.Popen) -> None:
        """Pipe an object into a process's stdin (e.g. a remote `tar xzf -`)."""

        def _download() -> None:
            assert proc.stdin is not None
            self.client.download_fileobj(self.bucket, key, proc.stdin)
            proc.stdin.close()
            code = proc.wait(timeout=120)
            if code != 0:
                err = proc.stderr.read().decode(errors="replace") if proc.stderr else ""
                raise RuntimeError(f"sink process exited {code}: {err[-400:]}")

        await asyncio.to_thread(_download)

    async def put_bytes(self, key: str, data: bytes, content_type: str) -> None:
        await asyncio.to_thread(
            self.client.put_object, Bucket=self.bucket, Key=key, Body=data, ContentType=content_type
        )


class _CountingReader:
    def __init__(self, inner: IO[bytes]):
        self.inner = inner
        self.count = 0

    def read(self, size: int = -1) -> bytes:
        chunk = self.inner.read(size)
        self.count += len(chunk)
        return chunk
