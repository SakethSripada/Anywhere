"""Anywhere LoRA / QLoRA supervised fine-tuning job.

Runs on the provisioned GPU. Reads a validated config.json written by the
control plane (never model-generated code), trains a LoRA adapter on the
uploaded dataset, and writes:
  metrics.jsonl     {"step", "loss", "lr", "epoch", ...} per logging step
  outputs/adapter/  PEFT adapter weights
  outputs/samples.json  generations from the tuned model for a few prompts
"""

import argparse
import json
import math
import time
from pathlib import Path

import torch
from datasets import load_dataset
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    Trainer,
    TrainerCallback,
    TrainingArguments,
)


class JsonlMetrics(TrainerCallback):
    def __init__(self, path: Path):
        self.path = path
        self.started = time.time()

    def on_log(self, args, state, control, logs=None, **kwargs):
        if not logs:
            return
        row = {"step": state.global_step, "max_steps": state.max_steps, "elapsed_s": round(time.time() - self.started)}
        for k, v in logs.items():
            if isinstance(v, int | float) and math.isfinite(v):
                row[k] = v
        with self.path.open("a") as f:
            f.write(json.dumps(row) + "\n")


def to_text(example: dict, tokenizer) -> str:
    if "messages" in example:
        return tokenizer.apply_chat_template(example["messages"], tokenize=False)
    if "prompt" in example and "response" in example:
        msgs = [{"role": "user", "content": example["prompt"]}, {"role": "assistant", "content": example["response"]}]
        return tokenizer.apply_chat_template(msgs, tokenize=False)
    if "instruction" in example and "output" in example:
        prompt = example["instruction"] + (("\n\n" + example["input"]) if example.get("input") else "")
        msgs = [{"role": "user", "content": prompt}, {"role": "assistant", "content": example["output"]}]
        return tokenizer.apply_chat_template(msgs, tokenize=False)
    return example["text"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    cfg = json.loads(Path(parser.parse_args().config).read_text())

    out = Path("outputs")
    out.mkdir(exist_ok=True)
    metrics = Path("metrics.jsonl")
    bf16 = torch.cuda.is_available() and torch.cuda.is_bf16_supported()
    dtype = torch.bfloat16 if bf16 else torch.float16

    tokenizer = AutoTokenizer.from_pretrained(cfg["base_model"])
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    quant = None
    if cfg["method"] == "qlora":
        quant = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=dtype,
            bnb_4bit_use_double_quant=True,
        )
    model = AutoModelForCausalLM.from_pretrained(
        cfg["base_model"], torch_dtype=dtype, quantization_config=quant, device_map="auto"
    )
    if quant is not None:
        model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    else:
        # Gradient checkpointing with a frozen base model: unless the embeddings'
        # output requires grad, checkpointed layers return tensors without a grad_fn
        # and the first backward() fails ("element 0 of tensors does not require
        # grad"). prepare_model_for_kbit_training does this for QLoRA; plain LoRA
        # needs it explicitly.
        model.enable_input_require_grads()
    model = get_peft_model(
        model,
        LoraConfig(
            r=cfg["lora_r"],
            lora_alpha=cfg["lora_r"] * 2,
            lora_dropout=0.05,
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
            task_type="CAUSAL_LM",
        ),
    )
    model.print_trainable_parameters()

    ds = load_dataset("json" if cfg["dataset_format"] == "jsonl" else "csv", data_files=cfg["dataset_path"])["train"]
    if cfg.get("max_examples"):
        ds = ds.select(range(min(len(ds), cfg["max_examples"])))

    def tokenize(batch):
        rows = [dict(zip(batch, vals, strict=True)) for vals in zip(*batch.values(), strict=True)]
        texts = [to_text(r, tokenizer) for r in rows]
        enc = tokenizer(texts, truncation=True, max_length=cfg["max_seq_len"], padding=False)
        enc["labels"] = [ids.copy() for ids in enc["input_ids"]]
        return enc

    tokenized = ds.map(tokenize, batched=True, remove_columns=ds.column_names)
    split = (
        tokenized.train_test_split(test_size=min(0.05, 64 / max(len(tokenized), 1)), seed=7)
        if len(tokenized) > 40
        else None
    )

    def collate(features):
        width = max(len(f["input_ids"]) for f in features)
        pad = tokenizer.pad_token_id

        def padded(key, value):
            return torch.tensor([f[key] + [value] * (width - len(f[key])) for f in features])

        return {
            "input_ids": padded("input_ids", pad),
            "attention_mask": padded("attention_mask", 0),
            "labels": padded("labels", -100),
        }

    args = TrainingArguments(
        output_dir=str(out / "checkpoints"),
        num_train_epochs=cfg["epochs"],
        per_device_train_batch_size=cfg["batch_size"],
        gradient_accumulation_steps=cfg["grad_accum"],
        learning_rate=cfg["learning_rate"],
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        logging_steps=5,
        eval_strategy="steps" if split else "no",
        eval_steps=50,
        save_strategy="steps",
        save_steps=200,
        save_total_limit=1,
        bf16=bf16,
        fp16=not bf16,
        gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False},
        report_to=[],
    )
    trainer = Trainer(
        model=model,
        args=args,
        train_dataset=split["train"] if split else tokenized,
        eval_dataset=split["test"] if split else None,
        data_collator=collate,
        callbacks=[JsonlMetrics(metrics)],
    )
    trainer.train()
    model.save_pretrained(out / "adapter")
    tokenizer.save_pretrained(out / "adapter")

    model.eval()
    samples = []
    for prompt in cfg.get("sample_prompts", [])[:4]:
        text = tokenizer.apply_chat_template(
            [{"role": "user", "content": prompt}], tokenize=False, add_generation_prompt=True
        )
        ids = tokenizer(text, return_tensors="pt").to(model.device)
        with torch.no_grad():
            gen = model.generate(**ids, max_new_tokens=200, do_sample=False)
        samples.append(
            {
                "prompt": prompt,
                "response": tokenizer.decode(gen[0][ids["input_ids"].shape[1] :], skip_special_tokens=True),
            }
        )
    (out / "samples.json").write_text(json.dumps(samples, indent=2))


if __name__ == "__main__":
    main()
