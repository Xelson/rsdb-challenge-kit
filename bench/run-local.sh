#!/usr/bin/env bash
# Runs the benchmarks on the development machine (SPEC §14.6), inside the kit Node image:
#   kit/bench/run-local.sh [--scale 0.25] [--only B2,B3] [--reps 1] [--no-build] [--warmup 10] [--window 60] [--keep-logs]
# Builds the submission first (kit/docker/build.sh all) unless --no-build, then prints raw metrics per scenario as a table and as
# JSON (also written to <repo>/bench-results/). No points: they depend on the other submission (§14.5).
# Environment: RSDB_REPO (submission root, default: parent of kit/), RSDB_SERVER_IMAGE (default rsdb-server:local), RSDB_SDK (built
# SDK directory, default <repo>/sdk), RSDB_OUT (default <repo>/bench-results), RSDB_NODE_ENV (JSON of extra server environment),
# RSDB_GEN_ENV (JSON of extra environment for the load generators, which load the SDK).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
kit=$(dirname "$here")
repo=$(cd "${RSDB_REPO:-$kit/..}" && pwd)
build=1
args=()
for a in "$@"; do
  if [ "$a" = --no-build ]; then build=0; else args+=("$a"); fi
done
if [ "$build" = 1 ]; then "$kit/docker/build.sh" all "$repo"; fi
sdk=$(cd "${RSDB_SDK:-$repo/sdk}" && pwd)
out=${RSDB_OUT:-$repo/bench-results}
mkdir -p "$out"
out=$(cd "$out" && pwd)
tag=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$kit/package.json" | head -1)
run="b$(date +%s)$$"
# The single-node server may use 8 GiB (§14.1) and the generators need more; below that the kernel kills containers early.
mem=$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)
if [ "$mem" -lt $((12 * 1024 * 1024 * 1024)) ]; then
  echo "warning: Docker has $((mem / 1024 / 1024)) MiB of memory; give it at least 12 GiB, or servers and generators may be OOM-killed before reaching their limits" >&2
fi
# --cgroupns host: the runner reads every container's cgroup (§14.2 mem, cpu, cli_*).
exec docker run --rm --name "rsdb-bench-$run" --init --cgroupns host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$sdk:/sdk:ro" -v "$kit:/kit:ro" -v "$out:/out" \
  -e RSDB_RUN="$run" -e RSDB_SELF="rsdb-bench-$run" \
  -e RSDB_SERVER_IMAGE="${RSDB_SERVER_IMAGE:-rsdb-server:local}" -e RSDB_NODE_ENV="${RSDB_NODE_ENV:-}" -e RSDB_GEN_ENV="${RSDB_GEN_ENV:-}" \
  -e RSDB_HOST_KIT="$kit" -e RSDB_HOST_SDK="$sdk" -e RSDB_HOST_OUT="$out" \
  "rsdb-kit/node:$tag" node /kit/bench/run.ts --out /out ${args[@]+"${args[@]}"}
