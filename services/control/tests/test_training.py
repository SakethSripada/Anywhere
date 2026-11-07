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
