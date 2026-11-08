import json

import pytest

from anywhere.training import DatasetError, base_model_for, build_config, inspect_dataset


def jsonl(rows):
    return "\n".join(json.dumps(r) for r in rows).encode()


def test_prompt_response_jsonl_is_profiled():
    data = jsonl([{"prompt": f"q{i}", "response": f"a{i}"} for i in range(50)])
    p = inspect_dataset("train.jsonl", data, len(data))
    assert p.format == "jsonl" and p.schema_ == "prompt_response" and p.rows == 50
    assert p.sample_prompts


def test_csv_with_text_column():
    data = b"text\nhello\nworld\n"
    assert inspect_dataset("d.csv", data, len(data)).schema_ == "text"


def test_unknown_columns_are_explained():
    data = jsonl([{"foo": 1}])
    with pytest.raises(DatasetError, match="Unrecognised columns"):
        inspect_dataset("d.jsonl", data, len(data))


def test_bad_json_and_extensions_are_rejected():
    with pytest.raises(DatasetError):
        inspect_dataset("d.jsonl", b"{not json}\n", 11)
    with pytest.raises(DatasetError):
        inspect_dataset("d.parquet", b"x", 1)


def test_oversized_datasets_are_rejected():
    with pytest.raises(DatasetError):
        inspect_dataset("d.jsonl", b"{}", 10**10)


def test_config_is_clamped_to_allowlisted_models():
    assert base_model_for(7)[0] == "Qwen/Qwen2.5-7B-Instruct"
    assert base_model_for(None)[0] == "Qwen/Qwen2.5-0.5B-Instruct"
    with pytest.raises(DatasetError):
        base_model_for(70)
    data = jsonl([{"prompt": "q", "response": "a"}] * 10)
    profile = inspect_dataset("t.jsonl", data, len(data))
    cfg = build_config(params_b=7, epochs=None, profile=profile, dataset_path="data.jsonl", vram_gb=24)
    assert cfg.method == "qlora" and cfg.max_seq_len == 2048 and cfg.epochs == 3


def test_lora_training_script_keeps_gradients_flowing_through_checkpointed_layers():
    # Plain LoRA (the default for models up to 1.5B) freezes the embeddings; with
    # gradient checkpointing on, the first backward() fails unless the inputs are
    # made to require grad or non-reentrant checkpointing is used. Torch isn't
    # installed here, so check the vetted script's source.
    from importlib import resources

    src = resources.files("anywhere.environments").joinpath("train.py").read_text()
    compile(src, "train.py", "exec")
    assert "model.enable_input_require_grads()" in src
    assert '"use_reentrant": False' in src


def _run_batch_script(tmp_path, python_body: str) -> tuple[str, str]:
    import os
    import shutil
    import subprocess
    from importlib import resources

    if not shutil.which("bash"):
        pytest.skip("bash is not available")
    job = tmp_path / "home" / "workspace" / "anywhere" / "job"
    job.mkdir(parents=True)
    (job / "run.sh").write_text(resources.files("anywhere.environments").joinpath("batch-run.sh").read_text())
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    stubs = {
        "nvidia-smi": 'echo "Tesla T4, 15360 MiB"',
        "uv": 'if [ "$1" = venv ]; then mkdir -p .venv/bin && : > .venv/bin/activate; fi',
        "python": python_body,
    }
    for name, body in stubs.items():
        (bin_ / name).write_text(f"#!/bin/sh\n{body}\n")
        (bin_ / name).chmod(0o755)
    env = {"HOME": str(tmp_path / "home"), "PATH": f"{bin_}:/usr/bin:/bin"}
    subprocess.run(["bash", "run.sh"], cwd=job, env=env, capture_output=True, timeout=60, check=False)
    assert os.path.exists(job / "pid")
    return (job / "status").read_text().strip(), (job / "run.log").read_text()


def test_batch_runner_reports_the_python_error_and_logs_it_before_the_status(tmp_path):
    status, log = _run_batch_script(
        tmp_path,
        'echo "Traceback (most recent call last):"\n'
        'echo "torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB" >&2\nexit 1',
    )
    assert status == (
        "failed: Training exited with an error (exit 1): "
        "torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB"
    )
    assert "::error::" in log and "Traceback" in log


def test_batch_runner_marks_success_after_the_last_step(tmp_path):
    status, log = _run_batch_script(tmp_path, "echo trained")
    assert status == "succeeded"
    assert log.rstrip().endswith("::step:: Done")
