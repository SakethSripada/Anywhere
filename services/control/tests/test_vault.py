"""The vault survives a corrupted file and skips writes that change nothing."""

from anywhere.vault import Vault


def test_recovers_from_a_truncated_vault(tmp_path):
    path = tmp_path / "vault.json"
    v = Vault(path)
    v.update(1, segment_base=5)
    v.update(1, segment_base=7)  # previous version becomes the backup
    path.write_text('{"workloads": {"1": {"segm')  # crash mid-write
    assert Vault(path).get(1)["segment_base"] == 5


def test_unchanged_updates_do_not_rewrite_the_file(tmp_path):
    path = tmp_path / "vault.json"
    v = Vault(path)
    v.update(1, log_offset=10)
    before = path.stat().st_mtime_ns
    path.touch()
    touched = path.stat().st_mtime_ns
    v.update(1, log_offset=10)
    assert path.stat().st_mtime_ns == touched and touched >= before


def test_section_update_never_resurrects_a_deleted_record(tmp_path):
    v = Vault(tmp_path / "vault.json")
    v.section_put("oauth_grants", "7", {"owner": "a"})
    assert v.section_update("oauth_grants", "7", conversation_id=3)["conversation_id"] == 3
    v.section_pop("oauth_grants", "7")
    assert v.section_update("oauth_grants", "7", conversation_id=4) is None
    assert v.section_get("oauth_grants", "7") is None


def test_unused_grants_and_idle_clients_are_purged(tmp_path):
    v = Vault(tmp_path / "vault.json")
    v.section_put("oauth_clients", "old", {"client_id": "old", "client_id_issued_at": 0})
    now = 2_000_000_000  # 2033
    v.section_put("oauth_clients", "new", {"client_id": "new", "client_id_issued_at": now - 60})
    v.section_put("oauth_clients", "used", {"client_id": "used", "client_id_issued_at": 0})
    v.section_put("oauth_grants", "1", {"id": 1, "client_id": "used"})
    v.section_put("oauth_refresh", "r", {"grant_id": 1, "client_id": "used", "expires_ts": 9e9})
    v.section_put("oauth_grants", "2", {"id": 2, "client_id": "old", "created_at": "2020-01-01T00:00:00+00:00"})
    v.purge_unused(now_ts=now, client_idle_seconds=3600)
    assert v.section_get("oauth_grants", "2") is None and v.section_get("oauth_grants", "1")
    assert {k for k, _ in v.section_items("oauth_clients")} == {"new", "used"}
