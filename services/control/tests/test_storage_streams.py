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


class RecordingClient:
    def __init__(self):
        self.objects: dict[str, bytes] = {"k": b"last good snapshot"}

    def upload_fileobj(self, f, bucket, key, ExtraArgs=None):
        self.objects[key] = f.read()

    def copy(self, source, bucket, key, ExtraArgs=None):
        self.objects[key] = self.objects[source["Key"]]

    def delete_object(self, Bucket, Key):
        self.objects.pop(Key, None)


def _storage(tmp_path, client):
    storage = Storage(Settings(_env_file=None, data_dir=tmp_path, s3_bucket="b"))
    storage._client = client
    return storage


async def test_a_failed_source_never_replaces_the_last_good_object(tmp_path):
    client = RecordingClient()
    storage = _storage(tmp_path, client)
    proc = LocalRemote("h").popen("import sys\nsys.stdout.write('trunc')\nsys.exit(2)", stdout=subprocess.PIPE)
    with pytest.raises(RuntimeError, match="exited 2"):
        await storage.upload_stream(proc, "k", "application/gzip")
    assert client.objects == {"k": b"last good snapshot"}  # temp object cleaned up too


async def test_a_tolerated_exit_code_still_publishes(tmp_path):
    client = RecordingClient()
    storage = _storage(tmp_path, client)
    proc = LocalRemote("h").popen("import sys\nsys.stdout.write('new')\nsys.exit(1)", stdout=subprocess.PIPE)
    assert await storage.upload_stream(proc, "k", "application/gzip", ok_exit=frozenset({0, 1})) == 3
    assert client.objects == {"k": b"new"}
