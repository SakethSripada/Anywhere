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
    p = plan(make(kind="desktop", application="blender", session_hours=2, session_hours_stated=True), Catalog())
    assert isinstance(p, Plan)
    est = p.selected.estimate
    assert est.confidence == "high"
    assert est.hours_low == est.hours_high


def test_a_guessed_session_is_a_low_confidence_range_from_one_hour():
    # Seen live: the agent guessed 6 h for a "hyper-detailed" scene and it was shown as a
    # confident $7.57 commitment. A guess must read as a guess.
    p = plan(make(kind="desktop", application="blender", session_hours=6), Catalog())
    assert isinstance(p, Plan)
    est = p.selected.estimate
    assert est.confidence == "low"
    assert est.hours_low < 2 < est.hours_high  # 1 h to start (+ setup) up to the guess
    assert any("guessed" in a for a in est.assumptions)
    assert any("stop any time" in a for a in est.assumptions)


def test_no_stated_session_plans_one_hour():
    est = plan(make(kind="desktop", application="blender"), Catalog()).selected.estimate
    assert est.hours_low == est.hours_high < 1.5


def test_blender_plans_carry_per_gpu_render_times():
    p = plan(make(kind="desktop", application="blender"), Catalog())
    rows = p.render_time["rows"]
    assert rows and len({r["gpu"] for r in rows}) == len(rows)
    assert all(0 < r["minutes_low"] < r["minutes_high"] for r in rows)
    assert plan(make(kind="desktop", application="vscode"), Catalog()).render_time is None


def test_render_jobs_are_ranked_by_measured_speed():
    heavy = dict(kind="render", scene_complexity="heavy", render_frames=24, render_samples=256)
    fastest = plan(make(**heavy, preference="fastest"), Catalog())
    balanced = plan(make(**heavy), Catalog())
    # L40S renders these benchmark scenes fastest; L4 beats A10G on both speed and price.
    assert fastest.selected.offer["gpu"] == "L40S"
    assert balanced.selected.offer["gpu"] == "L4"
    assert fastest.selected.estimate.hours_high < balanced.selected.estimate.hours_high


def test_render_time_scales_with_frames_pixels_and_samples():
    from anywhere.render_bench import frame_minutes

    base = frame_minutes("L4", "detailed", 1920, 1080, 128)
    assert frame_minutes("L4", "detailed", 3840, 2160, 128).minutes_low == pytest.approx(base.minutes_low * 4)
    assert frame_minutes("L4", "detailed", 1920, 1080, 256).minutes_low == pytest.approx(base.minutes_low * 2)
    assert frame_minutes("L40S", "detailed").minutes_low < base.minutes_low
    assert frame_minutes("Tesla T4").runs == 1 and frame_minutes("NVIDIA L4").gpu == "L4"
    assert frame_minutes("GTX 1080") is None


def test_render_probe_extrapolation_separates_overhead_from_sampling():
    from anywhere.render_bench import extrapolate

    probe = {
        "points": [[8, 2.0], [32, 5.0]],
        "probe_width": 480,
        "probe_height": 270,
        "full_width": 1920,
        "full_height": 1080,
        "target_samples": 256,
    }
    r = extrapolate(probe, frames=24)
    # 1 s fixed overhead + (3 s per 24 samples at 1/16 the pixels) scaled to 256 samples, 16x pixels.
    assert r["overhead_seconds"] == pytest.approx(1.0)
    assert r["seconds_per_frame"] == pytest.approx(1 + 3 / 24 * 256 * 16, rel=1e-3)
    assert r["total_minutes"] == pytest.approx(r["seconds_per_frame"] * 24 / 60, rel=1e-2)
    noisy = extrapolate({**probe, "points": [[8, 2.0], [32, 1.9]]})
    assert noisy["seconds_per_frame"] > 0


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
