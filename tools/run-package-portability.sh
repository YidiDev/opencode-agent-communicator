#!/usr/bin/env bash
set -euo pipefail

readonly root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly dockerfile="$root/docker/package-portability.Dockerfile"

command -v docker >/dev/null 2>&1 || {
  printf '%s\n' 'docker is required for the package portability harness' >&2
  exit 1
}
docker info >/dev/null

for target in source packed; do
  printf '\n=== Alpine package portability: %s entry ===\n' "$target"
  docker build --pull --target "$target" --file "$dockerfile" "$root"
done
