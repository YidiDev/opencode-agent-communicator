#!/usr/bin/env bash
set -euo pipefail

debian="oven/bun:1.4.0-debian@sha256:5bb0f9be3a1a36a03e27c9a9dd894a3b1ad26657155c7df4dda771e17bf872ef"
alpine="oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb"

for libc in debian alpine; do
  image="opencode-agent-communicator-export-capability-${libc}:${GITHUB_SHA:-local}"
  base_image="${!libc}"
  docker build --build-arg "BASE_IMAGE=$base_image" \
    --file docker/export-capability.Dockerfile --tag "$image" .
  docker run --rm \
    --network none \
    --read-only \
    --env LD_LIBRARY_PATH=/tmp/hostile-loader-search \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777 \
    --cap-drop ALL \
    --cap-add DAC_READ_SEARCH \
    --security-opt no-new-privileges=true \
    --pids-limit 128 \
    --memory 512m \
    --cpus 1 \
    "$image"
done
