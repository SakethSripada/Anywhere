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
import secrets
import subprocess
from dataclasses import dataclass
from typing import IO

import boto3
import structlog
from botocore.config import Config
from botocore.exceptions import ClientError

from .config import Settings
from .remote import end_process, stderr_tail

log = structlog.get_logger()

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
            endpoint_url=s.s3_endpoint_url or None,
            region_name=client_region(s.s3_endpoint_url, s.s3_region),
            aws_access_key_id=s.s3_access_key_id.get_secret_value(),
            aws_secret_access_key=s.s3_secret_access_key.get_secret_value(),
            config=client_config(s.s3_endpoint_url),
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
        """Object metadata, or None if it doesn't exist. Auth and network errors raise."""

        def _head():
            try:
                return self.client.head_object(Bucket=self.bucket, Key=key)
            except ClientError as exc:
                if _status(exc) == 404 or _code(exc) in ("404", "NoSuchKey", "NotFound"):
                    return None
                raise StorageUnavailable(f"Object storage error ({_code(exc) or _status(exc)})") from exc

        return await asyncio.to_thread(_head)

    async def read_range(self, key: str, length: int) -> bytes:
        def _read() -> bytes:
            obj = self.client.get_object(Bucket=self.bucket, Key=key, Range=f"bytes=0-{max(length, 1) - 1}")
            return obj["Body"].read()

        return await asyncio.to_thread(_read)

    # ── Streaming ─────────────────────────────────────────────────────────
    async def upload_stream(
        self, proc: subprocess.Popen, key: str, content_type: str, *, ok_exit: frozenset[int] = frozenset({0})
    ) -> int:
        """Upload a process's stdout (e.g. a remote `tar czf -`) as one object.

        The bytes go to a temporary key first and only replace `key` once the
        upload finished and the source exited cleanly, so a dropped connection or a
        failed tar never overwrites the last good copy (say, a project snapshot).
        `ok_exit` lists source exit codes that still count as success."""

        def _upload() -> int:
            assert proc.stdout is not None
            tmp = f"{key}.{secrets.token_hex(4)}.partial"
            done = False
            try:
                counter = _CountingReader(proc.stdout)
                self.client.upload_fileobj(counter, self.bucket, tmp, ExtraArgs={"ContentType": content_type})
                code = proc.wait(timeout=60)
                if code not in ok_exit:
                    raise RuntimeError(f"source process exited {code}: {stderr_tail(proc)}")
                if code != 0:
                    log.warning("storage.source_exit_tolerated", key=key, code=code, stderr=stderr_tail(proc)[-300:])
                # Managed copy: multipart above 5 GB, where a plain copy_object fails.
                self.client.copy(
                    {"Bucket": self.bucket, "Key": tmp},
                    self.bucket,
                    key,
                    ExtraArgs={"ContentType": content_type, "MetadataDirective": "REPLACE"},
                )
                done = True
                return counter.count
            finally:
                # On any failure the remote tar would otherwise block forever on a
                # full pipe, leaving an ssh process behind.
                end_process(proc)
                try:
                    self.client.delete_object(Bucket=self.bucket, Key=tmp)
                except Exception as exc:  # a leftover .partial is clutter, not data loss
                    if done:
                        log.warning("storage.partial_cleanup_failed", key=tmp, error=str(exc)[:200])

        return await asyncio.to_thread(_upload)

    async def download_stream(self, key: str, proc: subprocess.Popen) -> None:
        """Pipe an object into a process's stdin (e.g. a remote `tar xzf -`)."""

        def _download() -> None:
            assert proc.stdin is not None
            try:
                self.client.download_fileobj(self.bucket, key, proc.stdin)
                proc.stdin.close()
                code = proc.wait(timeout=120)
                if code != 0:
                    raise RuntimeError(f"sink process exited {code}: {stderr_tail(proc)}")
            finally:
                end_process(proc)

        await asyncio.to_thread(_download)

    async def get_bytes(self, key: str) -> bytes:
        def _get() -> bytes:
            return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()

        return await asyncio.to_thread(_get)

    async def put_bytes(self, key: str, data: bytes, content_type: str) -> None:
        await asyncio.to_thread(
            self.client.put_object, Bucket=self.bucket, Key=key, Body=data, ContentType=content_type
        )


def client_region(endpoint_url: str | None, region: str) -> str:
    """`auto` is what R2 expects; AWS itself needs a real region."""
    if not endpoint_url and (not region or region == "auto"):
        return "us-east-1"
    return region or "auto"


def client_config(endpoint_url: str | None) -> Config:
    """SigV4 everywhere. Path-style addressing for non-AWS endpoints (R2, MinIO);
    AWS keeps virtual-hosted style. botocore >= 1.36 adds CRC checksums to every
    upload by default, which some S3-compatible stores reject, so non-AWS
    endpoints only send them when an operation requires it."""
    if not endpoint_url or endpoint_url.rstrip("/").endswith(".amazonaws.com"):
        return Config(signature_version="s3v4", retries={"max_attempts": 4, "mode": "standard"})
    return Config(
        signature_version="s3v4",
        retries={"max_attempts": 4, "mode": "standard"},
        s3={"addressing_style": "path"},
        request_checksum_calculation="when_required",
        response_checksum_validation="when_required",
    )


def _status(exc: ClientError) -> int | None:
    return exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")


def _code(exc: ClientError) -> str:
    return str(exc.response.get("Error", {}).get("Code", ""))


class _CountingReader:
    def __init__(self, inner: IO[bytes]):
        self.inner = inner
        self.count = 0

    def read(self, size: int = -1) -> bytes:
        chunk = self.inner.read(size)
        self.count += len(chunk)
        return chunk
