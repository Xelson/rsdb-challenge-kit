#!/usr/bin/env bash
# Runs the conformance suites (SPEC §13) against built images, inside the kit Node image.
#   kit/conformance/run.sh [--suite T1,T4] [--level L1|L2|L3] [--scale public|full] [--seeds "T3=1,2;T4=5"]
# Environment: RSDB_REPO (submission root, default: parent of kit/), RSDB_SERVER_IMAGE (default rsdb-server:local),
# RSDB_OUT (results directory, default <repo>/conformance-results), RSDB_NODE_ENV (JSON of extra node environment).
# Build first: kit/docker/build.sh base && kit/docker/build.sh all
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
kit=$(dirname "$here")
repo=$(cd "${RSDB_REPO:-$kit/..}" && pwd)
out=${RSDB_OUT:-$repo/conformance-results}
tag=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$kit/package.json" | head -1)
run="c$(date +%s)$$"
mkdir -p "$out"
exec docker run --rm --name "rsdb-judge-$run" --init \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$repo/sdk:/sdk:ro" -v "$kit:/kit:ro" -v "$out:/out" \
  -e RSDB_RUN="$run" -e RSDB_SELF="rsdb-judge-$run" \
  -e RSDB_SERVER_IMAGE="${RSDB_SERVER_IMAGE:-rsdb-server:local}" -e RSDB_NODE_ENV="${RSDB_NODE_ENV:-}" \
  "rsdb-kit/node:$tag" node /kit/conformance/run.ts --out /out "$@"
