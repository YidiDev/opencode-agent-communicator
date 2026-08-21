#!/usr/bin/env bash
set -euo pipefail

readonly root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly dockerfile="$root/docker/store-acceptance.Dockerfile"
readonly run_id="store-acceptance-$$"
containers=()
volumes=()

cleanup() {
  if ((${#containers[@]} > 0)); then
    docker rm --force "${containers[@]}" >/dev/null 2>&1 || true
  fi
  if ((${#volumes[@]} > 0)); then
    docker volume rm --force "${volumes[@]}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

command -v docker >/dev/null 2>&1 || {
  printf '%s\n' 'docker is required for the Linux store acceptance harness' >&2
  exit 1
}
docker info >/dev/null

for libc in debian alpine; do
  image="opencode-agent-communicator-store-acceptance:${libc}"
  docker build --pull --target "$libc" --file "$dockerfile" --tag "$image" "$root"
  readonly_volume="${run_id}-${libc}-readonly"
  volumes+=("$readonly_volume")
  docker volume create "$readonly_volume" >/dev/null
  printf '\n=== store acceptance: %s / named-volume RW initialization ===\n' "$libc"
  timeout --signal=KILL 30s docker run --rm --init --name "${run_id}-${libc}-readonly-init" \
    --network none --security-opt no-new-privileges \
    --mount "type=volume,source=$readonly_volume,target=/readonly-state" \
    "$image" readonly-init /readonly-state
  printf '\n=== store acceptance: %s / real read-only named-volume ===\n' "$libc"
  timeout --signal=KILL 30s docker run --rm --init --name "${run_id}-${libc}-readonly-probe" \
    --user 10001:10001 --network none --security-opt no-new-privileges \
    --mount "type=volume,source=$readonly_volume,target=/readonly-state,readonly" \
    "$image" readonly-probe /readonly-state
  for filesystem in overlay tmpfs; do
    container="${run_id}-${libc}-${filesystem}"
    containers+=("$container")
    printf '\n=== store acceptance: %s / %s ===\n' "$libc" "$filesystem"
    args=(
      run --rm --init --name "$container"
      --network none
      --pids-limit 128
      --memory 512m
      --cpus 2
      --security-opt no-new-privileges
      --env "ACCEPTANCE_FS=$filesystem"
      --env "ACCEPTANCE_LIBC=$libc"
    )
    if [[ "$filesystem" == tmpfs ]]; then
      args+=(--tmpfs /acceptance-tmpfs:rw,nosuid,nodev,noexec,size=16m,mode=0700,uid=10001,gid=10001)
      args+=(--env ACCEPTANCE_ROOT=/acceptance-tmpfs)
    else
      args+=(--env ACCEPTANCE_ROOT=/acceptance-overlay)
    fi
    timeout --signal=KILL 120s docker "${args[@]}" "$image"
  done
done
