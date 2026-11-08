#!/usr/bin/env bash
# Anywhere batch runner. Installs a pinned training stack into an isolated venv,
# runs the job, and leaves machine-readable markers for the control plane:
#   job/metrics.jsonl   one JSON object per logged step
#   job/run.log         combined stdout/stderr
#   job/status          "succeeded" | "failed: <reason>"
set -uo pipefail
JOB="$HOME/workspace/anywhere/job"
cd "$JOB"
echo $$ > pid  # the control plane checks this to notice a runner that died silently
exec > >(tee -a run.log) 2>&1

# The status file is what ends the job, so write it last: the control plane stops
# reading run.log once it sees a status, and `tee` may still be flushing.
fail() { echo "::error:: $*"; sleep 2; echo "failed: $*" > status; exit 1; }
# The last exception line Python printed, e.g. "torch.OutOfMemoryError: CUDA out of memory".
last_error() {
  sleep 1
  grep -aE '^[A-Za-z_][A-Za-z0-9_.]*(Error|Exception|Interrupt)\b' run.log | tail -n 1 | cut -c1-240
}

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
# Unbuffered so output reaches the streamed log as it happens (a pipe is otherwise
# block-buffered, and an OOM kill would lose the last lines). No progress bars:
# their carriage-return redraws flood the log.
export PYTHONUNBUFFERED=1 HF_HUB_DISABLE_PROGRESS_BARS=1 HF_DATASETS_DISABLE_PROGRESS_BARS=1
python train.py --config config.json
code=$?
if [ "$code" -ne 0 ]; then
  err=$(last_error)
  [ "$code" -eq 137 ] && [ -z "$err" ] && err="the machine ran out of memory"
  fail "Training exited with an error (exit $code)${err:+: $err}"
fi
echo "::step:: Done"
sleep 2
echo "succeeded" > status
