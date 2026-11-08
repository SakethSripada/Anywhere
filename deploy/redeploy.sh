#!/usr/bin/env bash
# Pull the latest `main` and redeploy Anywhere on this VM. Safe to run any time:
# it does nothing when the checkout is already current (unless --force).
#
#   deploy/redeploy.sh                 # from the `github` remote (the systemd timer runs this)
#   deploy/redeploy.sh --from origin   # from another remote, e.g. a bare repo you push to
#   deploy/redeploy.sh --force         # rebuild and restart even if nothing changed
#
# Order matters for uptime: images are built while the old containers keep
# serving, and nothing restarts unless the build succeeds.
set -euo pipefail

# `git pull` may rewrite this very file; bash reads scripts lazily, so run a copy.
if [[ -z "${ANYWHERE_REDEPLOY_COPY:-}" ]]; then
  copy=$(mktemp /tmp/anywhere-redeploy.XXXXXX)
  cp "$0" "$copy"
  ANYWHERE_REDEPLOY_COPY=1 exec bash "$copy" "$@"
fi

ROOT=${ANYWHERE_ROOT:-/opt/anywhere}
REMOTE=github
FORCE=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) REMOTE=$2; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { echo "$(date -u +%FT%TZ) $*"; }
cd "$ROOT"
compose=(docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile spacetime --profile messaging)

# One deploy at a time (the timer can fire while a slow build is still running).
exec 9>/run/anywhere-redeploy.lock
flock -n 9 || { log "another deploy is running; skipping"; exit 0; }

if ! git fetch -q "$REMOTE" main 2>/tmp/anywhere-fetch.err; then
  reason=$(grep -m1 -iE 'denied|fatal|error' /tmp/anywhere-fetch.err || tail -1 /tmp/anywhere-fetch.err)
  log "can't fetch $REMOTE/main: $reason (is the server's read-only deploy key added to the repo?)"
  exit 1
fi
old=$(git rev-parse HEAD)
new=$(git rev-parse "$REMOTE/main")
if [[ "$old" == "$new" && -z "$FORCE" ]]; then
  exit 0
fi
log "deploying ${new:0:7} (was ${old:0:7})"

# Fast-forward only, keeping this VM's local edits (e.g. the Caddyfile stdb block).
git merge -q --ff-only "$REMOTE/main"

# The SpacetimeDB module only needs publishing when it changed. Uses the owner's
# CLI login kept in /opt/stdb-cli (see "Self-hosting SpacetimeDB" in the README).
if [[ "$old" != "$new" ]] && ! git diff --quiet "$old" "$new" -- spacetime/module; then
  log "SpacetimeDB module changed; publishing"
  docker run --rm -u root --network anywhere_default -v "$ROOT":/repo -v /opt/stdb-cli:/root/.config/spacetime \
    --entrypoint bash clockworklabs/spacetime:v2.14.1 -c '
      set -e
      apt-get update -qq >/dev/null && apt-get install -y -qq curl ca-certificates >/dev/null
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 && apt-get install -y -qq nodejs >/dev/null
      cd /repo && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --frozen-lockfile --filter "@anywhere/spacetime-module..." >/dev/null
      cd spacetime/module && spacetime publish anywhere -y --server selfhost'
fi

log "building images"
if ! "${compose[@]}" build >/tmp/anywhere-build.log 2>&1; then
  tail -30 /tmp/anywhere-build.log
  log "BUILD FAILED; the previous version keeps running"
  exit 1
fi

"${compose[@]}" up -d --remove-orphans >/dev/null
# Compose sometimes leaves a container on its old image; move any straggler over.
for svc in control web messaging; do
  running=$(docker inspect -f '{{.Image}}' "anywhere-$svc-1" 2>/dev/null || true)
  latest=$(docker image inspect -f '{{.Id}}' "anywhere-$svc" 2>/dev/null || true)
  if [[ -n "$latest" && "$running" != "$latest" ]]; then
    log "recreating $svc on the new image"
    "${compose[@]}" up -d --force-recreate --no-deps "$svc" >/dev/null
  fi
done

for _ in $(seq 1 60); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' anywhere-control-1 2>/dev/null)" == healthy ]] && break
  sleep 3
done
if [[ "$(docker inspect -f '{{.State.Health.Status}}' anywhere-control-1 2>/dev/null)" != healthy ]]; then
  log "DEPLOYED ${new:0:7} BUT THE CONTROL PLANE IS NOT HEALTHY"
  docker logs --tail 30 anywhere-control-1 2>&1
  exit 1
fi
docker exec anywhere-control-1 anywhere doctor 2>&1 | grep -E '^\s+\[|ok,' || true
docker image prune -f >/dev/null 2>&1 || true
log "deployed ${new:0:7}"
