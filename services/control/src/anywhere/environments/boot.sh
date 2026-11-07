#!/usr/bin/env bash
# Passed to `brev create --startup-script`. Kept minimal: real configuration is
# pushed over SSH by the control plane so progress is observable and resumable.
# Pre-pulling here overlaps the large image download with boot.
mkdir -p "$HOME/workspace/anywhere/state"
( docker pull -q "{{PREPULL_IMAGE}}" || sudo docker pull -q "{{PREPULL_IMAGE}}" ) >/dev/null 2>&1 &
touch "$HOME/workspace/anywhere/state/booted"
