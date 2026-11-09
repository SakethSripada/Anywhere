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
# Brev can report a fresh VM as ready while the NVIDIA driver is still loading,
# so give it a few minutes before calling the GPU missing.
for i in $(seq 1 36); do
  nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader && break
  [ "$i" = 36 ] && { echo "::error:: No NVIDIA GPU is visible on this machine"; exit 1; }
  sleep 5
done

# Docker may still be starting this early in the first boot.
command -v docker >/dev/null || { echo "::error:: Docker is not installed on this machine"; exit 1; }
DOCKER=
for i in $(seq 1 36); do
  if docker info >/dev/null 2>&1; then DOCKER=docker; break; fi
  if sudo -n docker info >/dev/null 2>&1; then DOCKER="sudo docker"; break; fi
  [ "$i" = 1 ] && { sudo -n systemctl start docker >/dev/null 2>&1 || true; }
  sleep 5
done
[ -n "$DOCKER" ] || { echo "::error:: Docker did not start on this machine"; exit 1; }

step "Fetching the desktop image"
# A registry hiccup shouldn't cost the whole launch.
for i in 1 2 3; do
  $DOCKER pull -q "$IMAGE" && break
  [ "$i" = 3 ] && { echo "::error:: Could not download the desktop image $IMAGE"; exit 1; }
  sleep 10
done

if ! $DOCKER container inspect "$NAME" >/dev/null 2>&1; then
  step "Starting the desktop"
  # 6080 is the interactive VNC bridge, 6081 the view-only one for watch links.
  # Brev's NVIDIA runtime injects the driver's GLX/EGL libraries whatever
  # NVIDIA_DRIVER_CAPABILITIES says, and the image's Xvfb (+extension GLX) then
  # segfaults loading NVIDIA's EGL (seen on a T4, driver 595). Pointing glvnd at
  # Mesa keeps X and the viewport on software GL; CUDA/OptiX for Cycles still
  # reach the GPU through libcuda.
  if ! out=$($DOCKER run -d --name "$NAME" --restart unless-stopped \
    --gpus all -e NVIDIA_DRIVER_CAPABILITIES=all \
    -e __GLX_VENDOR_LIBRARY_NAME=mesa \
    -e __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json \
    -e CUA_ENV_TOKEN="{{CUA_TOKEN}}" \
    --shm-size=2g \
    -p 127.0.0.1:3211:3211 -p 127.0.0.1:6080:6080 -p 127.0.0.1:6081:6081 \
    -v "$ROOT/projects:/projects" \
    "$IMAGE" 2>&1); then
    echo "$out"
    echo "::error:: Docker could not start the desktop with GPU access: $(echo "$out" | tail -n 1 | cut -c1-200)"
    exit 1
  fi
fi

if ! $DOCKER exec "$NAME" test -f /opt/.anywhere-ready; then
  step "Installing Blender $BLENDER_VERSION and the browser bridge"
  $DOCKER exec -u root -e DEBIAN_FRONTEND=noninteractive "$NAME" sh -euc "
    apt-get -o DPkg::Lock::Timeout=300 update -qq
    apt-get -o DPkg::Lock::Timeout=300 install -y -qq --no-install-recommends x11vnc novnc websockify xz-utils curl ca-certificates \
      libxi6 libxkbcommon0 libxxf86vm1 libxfixes3 libxrender1 libgl1 libegl1 libsm6 libice6 >/dev/null
    f=blender-$BLENDER_VERSION-linux-x64.tar.xz
    # Retry, then fall back to official mirrors: one blender.org hiccup used to fail
    # the whole launch (curl exit 22). The checksum below vouches for any mirror.
    ok=
    for base in https://download.blender.org/release https://mirrors.ocf.berkeley.edu/blender/release \\
                https://ftp.nluug.nl/pub/graphics/blender/release; do
      if curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors --connect-timeout 20 \\
           -o /tmp/\$f \$base/Blender${BLENDER_VERSION%.*}/\$f; then ok=1; break; fi
      echo \"Blender download from \$base failed; trying the next mirror\" >&2
    done
    [ -n \"\$ok\" ] || { echo 'Could not download Blender from any mirror' >&2; exit 22; }
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
