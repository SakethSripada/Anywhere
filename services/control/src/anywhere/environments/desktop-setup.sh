#!/usr/bin/env bash
# Anywhere desktop environment — one-time setup on a Brev GPU VM.
#
# Runs Cua's maintained Linux desktop image (XFCE on Xvfb + cua-spacesd on
# :3211) with the NVIDIA runtime, then layers Blender (checksum-verified) and a
# loopback-only VNC bridge (x11vnc + websockify/noVNC on :6080) for the browser.
# Nothing listens on a public interface: the control plane reaches both ports
# through an SSH tunnel. Idempotent; safe to re-run.
set -euo pipefail

ROOT="$HOME/workspace/anywhere"
mkdir -p "$ROOT/projects" "$ROOT/state"
chmod 0777 "$ROOT/projects"
exec > >(tee -a "$ROOT/state/setup.log") 2>&1
step() { echo "::step:: $*"; }

IMAGE="{{DESKTOP_IMAGE}}"
BLENDER_VERSION="{{BLENDER_VERSION}}"
BLENDER_SHA256="{{BLENDER_SHA256}}"
NAME=anywhere-desktop

step "Checking the GPU"
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader \
  || { echo "::error:: No NVIDIA GPU is visible on this machine"; exit 1; }

DOCKER=docker
docker ps >/dev/null 2>&1 || DOCKER="sudo docker"
$DOCKER info >/dev/null 2>&1 || sudo systemctl start docker

step "Fetching the desktop image"
$DOCKER pull -q "$IMAGE"

if ! $DOCKER container inspect "$NAME" >/dev/null 2>&1; then
  step "Starting the desktop"
  $DOCKER run -d --name "$NAME" --restart unless-stopped \
    --gpus all -e NVIDIA_DRIVER_CAPABILITIES=all \
    -e CUA_ENV_TOKEN="{{CUA_TOKEN}}" \
    --shm-size=2g \
    -p 127.0.0.1:3211:3211 -p 127.0.0.1:6080:6080 \
    -v "$ROOT/projects:/projects" \
    "$IMAGE" >/dev/null \
    || { echo "::error:: Docker could not start the desktop with GPU access (is the NVIDIA Container Toolkit installed?)"; exit 1; }
fi

if ! $DOCKER exec "$NAME" test -f /opt/.anywhere-ready; then
  step "Installing Blender $BLENDER_VERSION and the browser bridge"
  $DOCKER exec -u root -e DEBIAN_FRONTEND=noninteractive "$NAME" sh -euc "
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends x11vnc novnc websockify xz-utils curl ca-certificates \
      libxi6 libxkbcommon0 libxxf86vm1 libxfixes3 libxrender1 libgl1 libegl1 libsm6 libice6 >/dev/null
    f=blender-$BLENDER_VERSION-linux-x64.tar.xz
    curl -fsSLo /tmp/\$f https://download.blender.org/release/Blender${BLENDER_VERSION%.*}/\$f
    echo '$BLENDER_SHA256  /tmp/'\$f | sha256sum -c -
    tar -xJf /tmp/\$f -C /opt && rm /tmp/\$f
    ln -sf /opt/blender-$BLENDER_VERSION-linux-x64/blender /usr/local/bin/blender
    touch /opt/.anywhere-ready
  "
fi

# ~/Projects for root and for the image's desktop user (Cua's shell runs as that user).
$DOCKER exec -u root "$NAME" sh -c 'for h in /root /home/*; do [ -d "$h" ] && ln -sfn /projects "$h/Projects"; done' || true
touch "$ROOT/state/setup-complete"
step "Desktop environment installed"
