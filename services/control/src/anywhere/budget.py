"""Spending policy. Pure functions so every rule is unit-tested.

Three layers protect the shared credit balance:
  1. Platform: a global budget and a concurrency limit nobody can exceed.
  2. Account: a monthly cap each user sets (bounded by the platform ceiling).
  3. Per-plan: an approval threshold; anything above it waits for a human yes.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import UTC, datetime

from .lifecycle import BILLABLE


@dataclass(frozen=True)
class AccountPolicy:
    activated: bool
    monthly_cap_cents: int
    approval_threshold_cents: int


@dataclass(frozen=True)
class SpendSnapshot:
    account_month_cents: int
    platform_cents: int
    active_instances: int
    account_active_kinds: tuple[str, ...] = ()


@dataclass(frozen=True)
class PlatformLimits:
    global_budget_cents: int
    max_concurrent_instances: int


@dataclass
class Decision:
    allowed: bool
    requires_approval: bool
    blockers: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def evaluate(
    *,
    kind: str,
    cost_high_cents: int,
    account: AccountPolicy,
    spend: SpendSnapshot,
    limits: PlatformLimits,
    machines: int = 1,
) -> Decision:
    blockers: list[str] = []
    notes: list[str] = []

    if not account.activated:
        blockers.append("Your account hasn't been activated yet. Redeem an invite code in Settings.")

    if kind == "desktop" and "desktop" in spend.account_active_kinds:
        blockers.append("You already have a desktop running. Open it, or stop it before starting another.")

    if machines > 1 and spend.active_instances + machines > limits.max_concurrent_instances:
        free = max(0, limits.max_concurrent_instances - spend.active_instances)
        blockers.append(
            f"This render uses {machines} GPUs at once, but only {free} more machine"
            f"{'s' if free != 1 else ''} can run right now. Ask for fewer GPUs, or stop a machine first."
        )
    elif spend.active_instances >= limits.max_concurrent_instances:
        blockers.append(
            f"Anywhere is limited to {limits.max_concurrent_instances} running machine"
            f"{'s' if limits.max_concurrent_instances != 1 else ''} right now. Stop one to continue."
        )

    remaining_platform = limits.global_budget_cents - spend.platform_cents
    if cost_high_cents > remaining_platform:
        blockers.append(
            f"This could cost up to {usd(cost_high_cents)}, but only {usd(max(remaining_platform, 0))} "
            "of platform credit remains."
        )

    remaining_account = account.monthly_cap_cents - spend.account_month_cents
    if cost_high_cents > remaining_account:
        blockers.append(
            f"This could cost up to {usd(cost_high_cents)}, which exceeds the {usd(max(remaining_account, 0))} "
            "left in your monthly cap. Raise the cap in Settings or choose a cheaper option."
        )

    requires_approval = cost_high_cents > account.approval_threshold_cents
    if not requires_approval:
        notes.append(f"Within your auto-approve limit of {usd(account.approval_threshold_cents)}.")

    return Decision(
        allowed=not blockers,
        requires_approval=requires_approval or bool(blockers),
        blockers=blockers,
        notes=notes,
    )


def accrued_cents(
    started_at: datetime | None, hourly_cents: int, prior_cents: int = 0, now: datetime | None = None
) -> int:
    """Cost of the current run segment plus anything billed in earlier segments."""
    if started_at is None:
        return prior_cents
    now = now or datetime.now(UTC)
    hours = max((now - started_at).total_seconds(), 0) / 3600
    return prior_cents + math.ceil(hours * hourly_cents)


def is_billable(status: str) -> bool:
    return status in BILLABLE


@dataclass(frozen=True)
class GuardAction:
    workload_id: int
    action: str  # "stop" | "save_and_stop" | "terminate"
    reason: str


def guard(
    *,
    workload_id: int,
    kind: str,
    status: str,
    accrued: int,
    est_high_cents: int,
    hours_running: float,
    idle_minutes: float | None,
    account_month_cents: int,
    account_cap_cents: int,
    platform_cents: int,
    limits: PlatformLimits,
    max_session_hours: float,
    desktop_idle_minutes: int,
) -> GuardAction | None:
    """Decide whether a running workload must be stopped right now."""
    if not is_billable(status) or status == "stopping":
        return None
    soft = "save_and_stop" if kind == "desktop" else "terminate"
    if platform_cents >= limits.global_budget_cents:
        return GuardAction(workload_id, soft, "Platform credit budget reached")
    if account_month_cents >= account_cap_cents:
        return GuardAction(workload_id, soft, "Monthly spending cap reached")
    if hours_running >= max_session_hours:
        return GuardAction(workload_id, soft, f"Reached the {max_session_hours:g} h session limit")
    if kind == "batch" and accrued > est_high_cents * 1.5 + 50:
        return GuardAction(workload_id, "terminate", "Ran well past its cost estimate")
    if kind == "desktop" and status == "running" and idle_minutes is not None and idle_minutes >= desktop_idle_minutes:
        return GuardAction(workload_id, "save_and_stop", f"Idle for {desktop_idle_minutes} minutes")
    return None


def usd(cents: int) -> str:
    return f"${cents / 100:,.2f}"
