#!/usr/bin/env bash
# Builds kit and submission images (SPEC §3).
#   kit/docker/build.sh base             kit base images rsdb-kit/{builder,runtime,node}:<kit version> (organizers, before kickoff)
#   kit/docker/build.sh server [<repo>]  <repo>/server -> image rsdb-server:local
#   kit/docker/build.sh sdk [<repo>]     npm ci && npm run build in <repo>/sdk, inside rsdb-kit/node
#   kit/docker/build.sh all [<repo>]     server and sdk
# <repo> defaults to the submission root (the parent of kit/).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
kit=$(dirname "$here")
repo=$(cd "${2:-$kit/..}" && pwd)
tag=$(node -p "require('$kit/package.json').version")
export DOCKER_BUILDKIT=1

base() {
  docker build -t "rsdb-kit/builder:$tag" -f "$here/builder.Dockerfile" "$here"
  docker build -t "rsdb-kit/runtime:$tag" -f "$here/runtime.Dockerfile" "$here"
  docker build -t "rsdb-kit/node:$tag" -f "$here/node.Dockerfile" "$kit"
}
server() {
  docker build -t "${RSDB_SERVER_IMAGE:-rsdb-server:local}" --build-arg "KIT_TAG=$tag" \
    -f "$here/server.Dockerfile" "$repo/server"
}
sdk() {
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$repo/sdk:/sdk" -w /sdk "rsdb-kit/node:$tag" \
    sh -c 'npm ci --no-audit --no-fund && npm run build'
}

case "${1:-}" in
  base) base ;;
  server) server ;;
  sdk) sdk ;;
  all) server; sdk ;;
  *) sed -n '2,7p' "$0"; exit 2 ;;
esac
