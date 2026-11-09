"""Workload lifecycle, mirrored from spacetime/module/src/lifecycle.ts.

SpacetimeDB is the authority (its reducer rejects illegal transitions); this
copy lets the supervisor reason about states without a round trip.
`tests/test_lifecycle.py` fails if the two tables drift apart.
"""

from enum import StrEnum


class Status(StrEnum):
    PLANNED = "planned"
    APPROVED = "approved"
    PROVISIONING = "provisioning"
    CONFIGURING = "configuring"
    RUNNING = "running"
    SAVING = "saving"
    STOPPING = "stopping"
    STOPPED = "stopped"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    TERMINATED = "terminated"


S = Status

TRANSITIONS: dict[Status, frozenset[Status]] = {
    S.PLANNED: frozenset({S.APPROVED, S.CANCELLED}),
    S.APPROVED: frozenset({S.PROVISIONING, S.CANCELLED, S.FAILED}),
    S.PROVISIONING: frozenset({S.CONFIGURING, S.STOPPING, S.FAILED, S.CANCELLED}),
    S.CONFIGURING: frozenset({S.RUNNING, S.STOPPING, S.FAILED, S.CANCELLED}),
    S.RUNNING: frozenset({S.SAVING, S.STOPPING, S.SUCCEEDED, S.FAILED}),
    S.SAVING: frozenset({S.RUNNING, S.STOPPING, S.FAILED}),
    S.STOPPING: frozenset({S.STOPPED, S.TERMINATED, S.FAILED}),
    S.STOPPED: frozenset({S.PROVISIONING, S.TERMINATED}),
    S.FAILED: frozenset({S.TERMINATED}),
    S.SUCCEEDED: frozenset({S.TERMINATED}),
    S.CANCELLED: frozenset(),
    S.TERMINATED: frozenset(),
}

#: Statuses during which an instance may exist and be billing.
BILLABLE = frozenset({S.PROVISIONING, S.CONFIGURING, S.RUNNING, S.SAVING, S.STOPPING})

#: Statuses with no further automatic work.
SETTLED = frozenset({S.STOPPED, S.SUCCEEDED, S.FAILED, S.CANCELLED, S.TERMINATED})


def can_transition(current: str, target: str) -> bool:
    try:
        return Status(target) in TRANSITIONS[Status(current)]
    except ValueError:
        return False


class IllegalTransition(Exception):
    def __init__(self, current: str, target: str):
        super().__init__(f"Illegal transition {current} → {target}")
        self.current = current
        self.target = target
