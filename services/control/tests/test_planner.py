import pytest

from anywhere.catalog import Catalog
from anywhere.planner import Intent, Plan, Unsupported, eligible, plan, size


def make(**kw) -> Intent:
    return Intent(summary="test", **kw)


def test_blender_desktop_picks_a_stoppable_gpu_with_enough_vram():
    p = plan(make(kind="desktop", application="blender"), Catalog())
    assert isinstance(p, Plan)
    assert p.requirements.mode == "interactive"
    assert p.selected.offer["stoppable"] is True
    assert p.selected.offer["vram_gb"] >= 16


def test_unsupported_apps_are_refused_honestly():
    result = plan(make(kind="desktop", application="unreal"), Catalog())
    assert isinstance(result, Unsupported)
    assert "Unreal" in result.reason


def test_cheapest_preference_minimises_cost():
    p = plan(make(kind="desktop", application="terminal", preference="cheapest"), Catalog())
    assert isinstance(p, Plan)
    all_costs = [p.selected.estimate.cost_high_cents] + [a.estimate.cost_high_cents for a in p.alternatives]
    assert p.selected.estimate.cost_high_cents == min(all_costs)


def test_fastest_preference_picks_the_fastest_gpu():
    p = plan(make(kind="fine_tune", model_params_billions=7, preference="fastest"), Catalog())
    assert isinstance(p, Plan)
    assert p.selected.offer["gpu"] == "L40S"


def test_7b_fine_tune_uses_qlora_and_needs_24gb():
    req = size(make(kind="fine_tune", model_params_billions=7))
    assert not isinstance(req, Unsupported)
    assert req.method.startswith("QLoRA")
    assert req.min_vram_gb == 24
    assert all(o.vram_gb >= 24 for o in eligible(req, Catalog().offers()))


def test_small_model_fits_a_t4():
    req = size(make(kind="fine_tune", model_params_billions=0.5))
    assert not isinstance(req, Unsupported)
    assert req.min_vram_gb <= 16


def test_huge_models_are_refused():
    assert isinstance(size(make(kind="fine_tune", model_params_billions=70)), Unsupported)


def test_unknown_dataset_size_yields_low_confidence_wide_range():
    p = plan(make(kind="fine_tune", model_params_billions=1.5), Catalog())
    assert isinstance(p, Plan)
    est = p.selected.estimate
    assert est.confidence == "low"
    assert est.hours_high > est.hours_low * 2


def test_known_dataset_size_tightens_confidence():
    p = plan(make(kind="fine_tune", model_params_billions=1.5, dataset_size_mb=5), Catalog())
    assert isinstance(p, Plan)
    assert p.selected.estimate.confidence == "medium"


def test_stated_session_length_is_respected():
    p = plan(make(kind="desktop", application="blender", session_hours=2), Catalog())
    assert isinstance(p, Plan)
    est = p.selected.estimate
    assert est.confidence == "high"
    assert est.hours_low == est.hours_high


def test_costs_scale_with_price():
    p = plan(make(kind="desktop", application="blender", session_hours=2), Catalog())
    assert isinstance(p, Plan)
    price = p.selected.offer["price_per_hour"]
    hours = p.selected.estimate.hours_high
    assert p.selected.estimate.cost_high_cents == pytest.approx(hours * price * 100, abs=1)


def test_budget_ceiling_reorders_or_warns():
    p = plan(make(kind="fine_tune", model_params_billions=7, max_budget_usd=0.01), Catalog())
    assert isinstance(p, Plan)
    assert p.warnings


def test_intent_rejects_nonsense_numbers():
    with pytest.raises(ValueError):
        make(kind="fine_tune", model_params_billions=-3)
    with pytest.raises(ValueError):
        make(kind="fine_tune", epochs=500)
