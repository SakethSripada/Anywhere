"""Guards against drift between the Python mirror and the SpacetimeDB module."""

import re
from pathlib import Path

from anywhere.lifecycle import TRANSITIONS, can_transition

TS = Path(__file__).resolve().parents[3] / "spacetime/module/src/lifecycle.ts"


def test_python_and_spacetime_transition_tables_match():
    source = TS.read_text()
    block = source.split("TRANSITIONS")[1].split("};")[0]
    ts_table = {
        m.group(1): set(re.findall(r'"(\w+)"', m.group(2))) for m in re.finditer(r"(\w+):\s*\[([^\]]*)\]", block)
    }
    py_table = {k.value: {v.value for v in vs} for k, vs in TRANSITIONS.items()}
    assert ts_table == py_table


def test_unknown_statuses_cannot_transition():
    assert not can_transition("planned", "exploding")
    assert can_transition("stopped", "provisioning")
