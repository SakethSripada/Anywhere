from datetime import UTC, datetime, timedelta

from anywhere.budget import AccountPolicy, PlatformLimits, SpendSnapshot, accrued_cents, evaluate, guard

LIMITS = PlatformLimits(global_budget_cents=5000, max_concurrent_instances=1)
ACCOUNT = AccountPolicy(activated=True, monthly_cap_cents=2000, approval_threshold_cents=0)
IDLE = SpendSnapshot(account_month_cents=0, platform_cents=0, active_instances=0)


def test_normal_plan_is_allowed_but_needs_approval_by_default():
    d = evaluate(kind="desktop", cost_high_cents=300, account=ACCOUNT, spend=IDLE, limits=LIMITS)
    assert d.allowed and d.requires_approval


def test_auto_approve_threshold():
    acct = AccountPolicy(True, 2000, approval_threshold_cents=500)
    d = evaluate(kind="desktop", cost_high_cents=300, account=acct, spend=IDLE, limits=LIMITS)
    assert d.allowed and not d.requires_approval


def test_inactive_accounts_are_blocked():
    d = evaluate(kind="desktop", cost_high_cents=1, account=AccountPolicy(False, 2000, 0), spend=IDLE, limits=LIMITS)
    assert not d.allowed


def test_concurrency_limit_blocks_second_machine():
    spend = SpendSnapshot(0, 0, active_instances=1)
    d = evaluate(kind="batch", cost_high_cents=100, account=ACCOUNT, spend=spend, limits=LIMITS)
    assert not d.allowed
    assert any("running machine" in b for b in d.blockers)


def test_duplicate_desktops_are_blocked():
    spend = SpendSnapshot(0, 0, active_instances=0, account_active_kinds=("desktop",))
    d = evaluate(kind="desktop", cost_high_cents=100, account=ACCOUNT, spend=spend, limits=PlatformLimits(5000, 5))
    assert not d.allowed


def test_monthly_cap_blocks_expensive_plans():
    spend = SpendSnapshot(account_month_cents=1900, platform_cents=1900, active_instances=0)
    d = evaluate(kind="batch", cost_high_cents=200, account=ACCOUNT, spend=spend, limits=LIMITS)
    assert not d.allowed
    assert any("monthly cap" in b for b in d.blockers)


def test_platform_budget_is_the_last_word():
    spend = SpendSnapshot(account_month_cents=0, platform_cents=4950, active_instances=0)
    d = evaluate(kind="batch", cost_high_cents=100, account=ACCOUNT, spend=spend, limits=LIMITS)
    assert not d.allowed


def test_accrual_is_prorated_and_includes_prior_segments():
    start = datetime(2026, 11, 7, 12, tzinfo=UTC)
    assert accrued_cents(start, 85, prior_cents=40, now=start + timedelta(minutes=30)) == 40 + 43
    assert accrued_cents(None, 85, prior_cents=12) == 12


def _guard(**kw):
    base = dict(
        workload_id=1,
        kind="desktop",
        status="running",
        accrued=50,
        est_high_cents=300,
        hours_running=0.5,
        idle_minutes=0,
        account_month_cents=50,
        account_cap_cents=2000,
        platform_cents=50,
        limits=LIMITS,
        max_session_hours=4,
        desktop_idle_minutes=20,
    )
    base.update(kw)
    return guard(**base)


def test_guard_leaves_healthy_workloads_alone():
    assert _guard() is None


def test_guard_saves_and_stops_idle_desktops():
    action = _guard(idle_minutes=25)
    assert action and action.action == "save_and_stop"


def test_guard_enforces_session_limit():
    assert _guard(hours_running=4.1).action == "save_and_stop"


def test_guard_terminates_runaway_batch_jobs():
    action = _guard(kind="batch", accrued=1000, est_high_cents=300, idle_minutes=None)
    assert action and action.action == "terminate"


def test_guard_stops_everything_at_the_platform_budget():
    assert _guard(platform_cents=5000).action == "save_and_stop"
    assert _guard(kind="batch", platform_cents=5000).action == "terminate"


def test_guard_ignores_settled_workloads():
    assert _guard(status="stopped", idle_minutes=999) is None
