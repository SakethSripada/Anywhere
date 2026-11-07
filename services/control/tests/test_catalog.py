import json

from anywhere.catalog import Catalog


def test_live_prices_overlay_known_types_only():
    c = Catalog()
    rows = [
        {"type": "g2-standard-4:nvidia-l4:1", "price_per_hour": 0.91, "stoppable": True},
        {"type": "gpu_8x_h100", "price_per_hour": 30.0, "stoppable": False},
    ]
    assert c.apply_live(json.dumps(rows)) == 1
    l4 = c.get("g2-standard-4:nvidia-l4:1")
    assert l4.price_per_hour == 0.91 and l4.price_source == "live"
    assert c.get("gpu_8x_h100") is None


def test_bad_live_payloads_keep_the_snapshot():
    c = Catalog()
    before = c.get("g5.xlarge").price_per_hour
    assert c.apply_live("not json") == 0
    assert c.apply_live(json.dumps([{"type": "g5.xlarge", "price_per_hour": -1}])) == 0
    assert c.get("g5.xlarge").price_per_hour == before


def test_every_catalog_entry_is_stoppable():
    assert all(o.stoppable for o in Catalog().offers())
