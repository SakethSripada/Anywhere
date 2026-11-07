"""Time-ordered 63-bit identifiers.

Reducers cannot return values, so the control plane assigns primary keys for
the rows it creates. 43 bits of milliseconds (good until 2248) followed by 20
random bits keeps ids sortable and collision-safe at our write rates, and below
2**63 so they stay positive in every language that touches them.
"""

import secrets
import time


def new_id() -> int:
    millis = int(time.time() * 1000) & ((1 << 43) - 1)
    return (millis << 20) | secrets.randbits(20)
