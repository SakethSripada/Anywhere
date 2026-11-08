"""Dataset inspection and training-config generation for LoRA fine-tunes.

The training job only ever runs the vetted script in environments/train.py.
What varies per job is a config produced here deterministically from the plan
and from inspecting the uploaded dataset; model suggestions are clamped to an
allowlist of ungated, Apache-2.0 base models.
"""

from __future__ import annotations

import csv
import io
import json
from typing import Literal

from pydantic import BaseModel, Field

#: (max params in billions, Hugging Face repo) — ungated, Apache-2.0.
BASE_MODELS: tuple[tuple[float, str], ...] = (
    (0.6, "Qwen/Qwen2.5-0.5B-Instruct"),
    (1.6, "Qwen/Qwen2.5-1.5B-Instruct"),
    (3.5, "Qwen/Qwen2.5-3B-Instruct"),
    (8.0, "Qwen/Qwen2.5-7B-Instruct"),
    (15.0, "Qwen/Qwen2.5-14B-Instruct"),
    (34.0, "Qwen/Qwen2.5-32B-Instruct"),
)

MAX_DATASET_BYTES = 200 * 1024 * 1024
RECOGNISED = ({"messages"}, {"prompt", "response"}, {"instruction", "output"}, {"text"})


class DatasetError(ValueError):
    pass


class DatasetProfile(BaseModel):
    format: Literal["jsonl", "csv"]
    schema_: Literal["messages", "prompt_response", "instruction", "text"] = Field(alias="schema")
    rows: int
    size_bytes: int
    sample_prompts: list[str]

    model_config = {"populate_by_name": True}


class TrainConfig(BaseModel):
    base_model: str
    method: Literal["lora", "qlora"]
    dataset_path: str
    dataset_format: Literal["jsonl", "csv"]
    #: Same range the planner accepts (Intent.epochs), so an allowed request can't fail here.
    epochs: int = Field(ge=1, le=20)
    batch_size: int = Field(ge=1, le=32)
    grad_accum: int = Field(ge=1, le=64)
    learning_rate: float = Field(gt=0, le=1e-3)
    lora_r: int = Field(ge=4, le=128)
    max_seq_len: int = Field(ge=128, le=4096)
    max_examples: int | None = Field(None, ge=1)
    sample_prompts: list[str] = Field(default_factory=list, max_length=4)


def base_model_for(params_b: float | None) -> tuple[str, float]:
    target = params_b or 0.5
    for limit, repo in BASE_MODELS:
        if target <= limit:
            return repo, target
    raise DatasetError(f"No supported base model for {target:g}B parameters")


def inspect_dataset(name: str, head: bytes, size_bytes: int) -> DatasetProfile:
    """Profile a dataset from its first ~1 MB. Raises DatasetError on anything unusable."""
    if size_bytes > MAX_DATASET_BYTES:
        raise DatasetError(f"Datasets are limited to {MAX_DATASET_BYTES // 2**20} MB")
    truncated = size_bytes > len(head)
    if truncated and (cut := head.rfind(b"\n")) >= 0:
        # Only the first ~1 MB was read: drop the partial last line, which can also
        # end mid-way through a multi-byte character and would fail to decode.
        head = head[: cut + 1]
    text = head.decode("utf-8", errors="strict") if head else ""
    lower = name.lower()
    if lower.endswith((".jsonl", ".json")):
        # split("\n"), not splitlines(): JSON strings may hold raw U+2028 and friends,
        # which splitlines() treats as line breaks.
        lines = [ln for ln in text.split("\n") if ln.strip()]
        if not lines:
            raise DatasetError("The dataset is empty")
        rows = []
        for i, line in enumerate(lines[:2000]):
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise DatasetError(f"Line {i + 1} is not valid JSON") from exc
            if not isinstance(row, dict):
                raise DatasetError(f"Line {i + 1} must be a JSON object")
            rows.append(row)
        keys = set(rows[0])
        records = len(lines)
        fmt: Literal["jsonl", "csv"] = "jsonl"
    elif lower.endswith(".csv"):
        reader = csv.DictReader(io.StringIO(text))
        everything = list(reader)
        rows = everything[:2000]
        if not rows:
            raise DatasetError("The CSV has no rows")
        records = len(everything)
        keys = set(reader.fieldnames or [])
        fmt = "csv"
    else:
        raise DatasetError("Upload a .jsonl or .csv file")

    schema = _schema(keys)
    # Scale the records in the sample (not just the 2000 parsed) up to the whole file.
    estimated_rows = max(records, int(records * size_bytes / max(len(head), 1)))
    return DatasetProfile(
        format=fmt,
        schema=schema,
        rows=estimated_rows,
        size_bytes=size_bytes,
        sample_prompts=_prompts(rows, schema),
    )


def _schema(keys: set[str]) -> Literal["messages", "prompt_response", "instruction", "text"]:
    if "messages" in keys:
        return "messages"
    if {"prompt", "response"} <= keys:
        return "prompt_response"
    if {"instruction", "output"} <= keys:
        return "instruction"
    if "text" in keys:
        return "text"
    raise DatasetError(
        "Unrecognised columns. Use one of: messages; prompt + response; instruction + output; or text. "
        f"Found: {', '.join(sorted(keys)) or 'none'}"
    )


def _prompts(rows: list[dict], schema: str) -> list[str]:
    picks: list[str] = []
    for row in rows[-3:]:
        if schema == "messages" and isinstance(row.get("messages"), list):
            user = next((m.get("content") for m in row["messages"] if m.get("role") == "user"), None)
            if isinstance(user, str):
                picks.append(user)
        elif schema == "prompt_response":
            picks.append(str(row["prompt"]))
        elif schema == "instruction":
            picks.append(str(row["instruction"]))
    return [p[:500] for p in picks]


def build_config(
    *, params_b: float | None, epochs: int | None, profile: DatasetProfile, dataset_path: str, vram_gb: float
) -> TrainConfig:
    repo, params = base_model_for(params_b)
    qlora = params > 1.6
    seq = 2048 if vram_gb >= 24 else 1024
    batch = 4 if params <= 1.6 else (2 if vram_gb >= 24 else 1)
    return TrainConfig(
        base_model=repo,
        method="qlora" if qlora else "lora",
        dataset_path=dataset_path,
        dataset_format=profile.format,
        epochs=epochs or (3 if profile.rows < 2000 else 1),
        batch_size=batch,
        grad_accum=max(1, 16 // batch),
        learning_rate=2e-4 if qlora else 1e-4,
        lora_r=16,
        max_seq_len=seq,
        max_examples=50_000,
        sample_prompts=profile.sample_prompts,
    )
