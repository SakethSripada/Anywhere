#!/usr/bin/env bash
# Anywhere render runner. Installs the pinned Blender, renders the project's frames
# on the GPU, and leaves the same markers as the training runner:
#   job/metrics.jsonl   one JSON object per rendered frame
#   job/run.log         combined stdout/stderr
#   job/status          "succeeded" | "failed: <reason>"
set -uo pipefail
JOB="$HOME/workspace/anywhere/job"
cd "$JOB"
echo $$ > pid  # the control plane checks this to notice a runner that died silently
exec > >(tee -a run.log) 2>&1

fail() { echo "failed: $*" > status; echo "::error:: $*"; exit 1; }
BLENDER_VERSION="{{BLENDER_VERSION}}"
BLENDER_SHA256="{{BLENDER_SHA256}}"
BLEND="{{BLEND}}"

echo "::step:: Checking the GPU"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || fail "No NVIDIA GPU visible"

echo "::step:: Installing Blender $BLENDER_VERSION"
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
# A fresh VM's unattended-upgrades often holds the dpkg lock for minutes: wait for it.
APT="apt-get -o DPkg::Lock::Timeout=300"
$SUDO $APT update -qq >/dev/null 2>&1
$SUDO env DEBIAN_FRONTEND=noninteractive $APT install -y -qq --no-install-recommends xz-utils curl ca-certificates \
  libxi6 libxkbcommon0 libxxf86vm1 libxfixes3 libxrender1 libgl1 libegl1 libsm6 libice6 >/dev/null 2>&1 \
  || fail "Could not install Blender's libraries"
f="blender-$BLENDER_VERSION-linux-x64.tar.xz"
if [ ! -x "$HOME/blender-$BLENDER_VERSION-linux-x64/blender" ]; then
  ok=
  for base in https://download.blender.org/release https://mirrors.ocf.berkeley.edu/blender/release \
              https://ftp.nluug.nl/pub/graphics/blender/release; do
    if curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors --connect-timeout 20 \
         -o "/tmp/$f" "$base/Blender${BLENDER_VERSION%.*}/$f"; then ok=1; break; fi
    echo "Blender download from $base failed; trying the next mirror"
  done
  [ -n "$ok" ] || fail "Could not download Blender from any mirror"
  echo "$BLENDER_SHA256  /tmp/$f" | sha256sum -c - >/dev/null || fail "Blender download failed its checksum"
  tar -xJf "/tmp/$f" -C "$HOME" && rm -f "/tmp/$f" || fail "Could not unpack Blender"
fi

echo "::step:: Rendering"
"$HOME/blender-$BLENDER_VERSION-linux-x64/blender" -b "project/$BLEND" -P render-frames.py -- config.json \
  || fail "Blender exited with an error while rendering"
ls renders/* >/dev/null 2>&1 || fail "Blender finished but wrote no frames"
echo "succeeded" > status
echo "::step:: Done"
