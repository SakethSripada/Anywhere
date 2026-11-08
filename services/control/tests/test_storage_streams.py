"""Streaming transfers always reap their process, even when the upload fails."""

import subprocess
import sys

import pytest

from anywhere.config import Settings
from anywhere.remote import Remote
from anywhere.storage import Storage


class LocalRemote(Remote):
    def _argv(self, command: str) -> list[str]:
        return [sys.executable, "-c", command]


class FailingClient:
    def upload_fileobj(self, f, bucket, key, ExtraArgs=None):
        f.read(10)
        raise RuntimeError("network down")


async def test_failed_upload_kills_and_reaps_the_source(tmp_path):
    storage = Storage(Settings(_env_file=None, data_dir=tmp_path, s3_bucket="b"))
    storage._client = FailingClient()
    # Writes far more than a pipe buffer, plus lots of stderr, then would block.
    src = "import sys\nsys.stderr.write('w'*200000)\nwhile True: sys.stdout.write('x'*65536)"
    proc = LocalRemote("h").popen(src, stdout=subprocess.PIPE)
    with pytest.raises(RuntimeError, match="network down"):
        await storage.upload_stream(proc, "k", "application/gzip")
    assert proc.returncode is not None
