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


def test_types_missing_from_the_live_feed_are_withheld():
    c = Catalog()
    rows = [{"type": o.type, "price_per_hour": o.price_per_hour, "stoppable": True} for o in c.offers()]
    gone = rows.pop()["type"]
    assert c.apply_live(json.dumps(rows)) == len(rows)
    assert gone not in {o.type for o in c.offers()}
    assert c.get(gone) is None and not c.available(gone)
    # It comes back as soon as Brev lists it again.
    rows.append({"type": gone, "price_per_hour": 1.0, "stoppable": True})
    c.apply_live(json.dumps(rows))
    assert c.available(gone)


def test_unrecognised_or_empty_feeds_do_not_hide_everything():
    c = Catalog()
    n = len(c.offers())
    c.apply_live(json.dumps([]))
    c.apply_live(json.dumps([{"type": "gpu_8x_h100", "price_per_hour": 30.0}]))
    assert len(c.offers()) == n


def test_snapshot_types_are_listed_on_brev():
    """Every type was checked against Brev's public feed on SNAPSHOT_AS_OF."""
    verified = {
        "g4dn.xlarge",
        "n1-standard-4:nvidia-tesla-t4:1",
        "g2-standard-4:nvidia-l4:1",
        "g2-standard-8:nvidia-l4:1",
        "g5.xlarge",
        "g6e.2xlarge",
    }
    assert {o.type for o in Catalog().offers()} == verified
