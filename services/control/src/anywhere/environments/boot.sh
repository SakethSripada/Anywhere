#!/usr/bin/env bash
# Passed to `brev create --startup-script`. Kept minimal: real configuration is
# pushed over SSH by the control plane so progress is observable and resumable.
# Pre-pulling here overlaps the large image download with boot.
#
# It may run as root, and before dockerd is up. So it writes nothing under $HOME
# (a root-owned ~/workspace would break the setup that later runs as the SSH
# user), and it waits for Docker in the background instead of giving up at once.
(
  for _ in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    sudo -n docker info >/dev/null 2>&1 && break
    sleep 5
  done
  docker pull -q "{{PREPULL_IMAGE}}" || sudo -n docker pull -q "{{PREPULL_IMAGE}}"
) >/dev/null 2>&1 &
exit 0
