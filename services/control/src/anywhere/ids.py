"""Time-ordered 53-bit identifiers.

Reducers cannot return values, so the control plane assigns primary keys for
rows it creates. SATS-JSON encodes integers as JSON numbers, so ids must stay
within 2**53 to survive every JSON parser between here and the browser:
32 bits of seconds since 2026-01-01 (good for 136 years) + 21 random bits.
"""

import secrets
import time

EPOCH = 1767225600  # 2026-01-01T00:00:00Z


def new_id() -> int:
    seconds = (int(time.time()) - EPOCH) & 0xFFFFFFFF
    return (seconds << 21) | secrets.randbits(21)
