from anywhere.store import plain_dashes


def test_em_dashes_become_commas():
    assert plain_dashes("NVIDIA T4 (16 GB) — the cheapest option") == "NVIDIA T4 (16 GB), the cheapest option"
    assert plain_dashes("fast—and cheap") == "fast, and cheap"


def test_number_ranges_keep_a_hyphen():
    assert plain_dashes("Usually 5–10 minutes") == "Usually 5-10 minutes"


def test_text_without_dashes_is_untouched():
    assert plain_dashes("A plain - hyphenated line.") == "A plain - hyphenated line."
