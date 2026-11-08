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
