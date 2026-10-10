#!/usr/bin/env bash
# Builds the local-development image (Containerfile) for linux/amd64 and
# linux/arm64 and pushes it to Docker Hub as $IMAGE:latest and
# $IMAGE:X.Y.Z (scripts/version.sh). Needs `docker login` first. DRY_RUN=1
# builds without pushing. See README "Local rbacr for your app".
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/version.sh
source scripts/version.sh
IMAGE="${IMAGE:-prodbytes/rbacr-local}"
output=(--push)
if [[ "${DRY_RUN:-}" == 1 ]]; then output=(); fi
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --file Containerfile \
  --tag "$IMAGE:latest" \
  --tag "$IMAGE:$VERSION" \
  "${output[@]}" \
  .
echo "${DRY_RUN:+built, not pushed: }$IMAGE:latest $IMAGE:$VERSION"
