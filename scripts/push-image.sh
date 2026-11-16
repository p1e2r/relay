#!/usr/bin/env bash
# Build the server image for amd64 + arm64 and push it.
#   ./scripts/push-image.sh                          -> ghcr.io/p1e2r/relay-server:latest
#   TAG=0.1.0 ./scripts/push-image.sh        -> ghcr.io/p1e2r/relay-server:0.1.0
# Log in first: echo $TOKEN | docker login ghcr.io -u p1e2r --password-stdin  (token needs write:packages)
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE="${IMAGE:-ghcr.io/p1e2r/relay-server}"
TAG="${TAG:-latest}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
docker buildx inspect relay-builder >/dev/null 2>&1 || docker buildx create --name relay-builder --use >/dev/null
docker buildx build --builder relay-builder --platform "$PLATFORMS" -t "$IMAGE:$TAG" --push .
echo "Pushed $IMAGE:$TAG"
