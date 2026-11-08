"""SATS-JSON decoding, using payloads captured from a SpacetimeDB 2.14 server."""

from datetime import UTC, datetime

from anywhere.stdb import decode

TS = {
    "Product": {
        "elements": [{"name": {"some": "__timestamp_micros_since_unix_epoch__"}, "algebraic_type": {"I64": []}}]
    }
}
OPT_TS = {
    "Sum": {
        "variants": [
            {"name": {"some": "some"}, "algebraic_type": TS},
            {"name": {"some": "none"}, "algebraic_type": {"Product": {"elements": []}}},
        ]
    }
}
ROW = {
    "Product": {
        "elements": [
            {"name": {"some": "id"}, "algebraic_type": {"U64": []}},
            {"name": {"some": "startedAt"}, "algebraic_type": OPT_TS},
            {"name": {"some": "lastActiveAt"}, "algebraic_type": OPT_TS},
        ]
    }
}


def test_decodes_array_encoded_options():
    row = decode([56338047556369, [0, [1794089700000000]], [1, []]], ROW)
    assert row["id"] == 56338047556369
    assert row["startedAt"] == datetime.fromtimestamp(1794089700, tz=UTC)
    assert row["lastActiveAt"] is None


def test_decodes_legacy_object_encoded_options():
    row = decode([1, {"some": {"__timestamp_micros_since_unix_epoch__": 0}}, {"none": []}], ROW)
    assert row["startedAt"] == datetime.fromtimestamp(0, tz=UTC)
    assert row["lastActiveAt"] is None
