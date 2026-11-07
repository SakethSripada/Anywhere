#!/usr/bin/env bash
# Anywhere batch runner. Installs a pinned training stack into an isolated venv,
# runs the job, and leaves machine-readable markers for the control plane:
#   job/metrics.jsonl   one JSON object per logged step
#   job/run.log         combined stdout/stderr
#   job/status          "succeeded" | "failed: <reason>"
set -uo pipefail
JOB="$HOME/workspace/anywhere/job"
cd "$JOB"
exec > >(tee -a run.log) 2>&1

fail() { echo "failed: $*" > status; echo "::error:: $*"; exit 1; }

echo "::step:: Checking the GPU"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || fail "No NVIDIA GPU visible"

echo "::step:: Installing the training stack"
if ! command -v uv >/dev/null; then
  curl -LsSf https://astral.sh/uv/0.12.0/install.sh | sh >/dev/null 2>&1 || fail "Could not install uv"
fi
export PATH="$HOME/.local/bin:$PATH"
uv venv -q --python 3.12 .venv || fail "Could not create a Python environment"
# shellcheck disable=SC1091
source .venv/bin/activate
uv pip install -q \
  "torch==2.9.*" "transformers==4.57.*" "peft==0.17.*" "accelerate==1.11.*" \
  "datasets==4.3.*" "bitsandbytes==0.48.*" || fail "Dependency installation failed"

echo "::step:: Training"
python train.py --config config.json || fail "Training exited with an error"
echo "succeeded" > status
echo "::step:: Done"
