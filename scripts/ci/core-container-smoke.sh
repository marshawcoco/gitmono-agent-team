#!/usr/bin/env bash
set -euo pipefail

for command in curl docker git; do
  command -v "$command" >/dev/null || {
    echo "Required command is missing: $command" >&2
    exit 1
  }
done

project_suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}"
project_suffix="$(printf '%s' "$project_suffix" | tr '[:upper:]_' '[:lower:]-' | tr -cd 'a-z0-9-')"
export COMPOSE_PROJECT_NAME="gitmono-ci-${project_suffix}"
export SCORPIOFS_IMAGE="${SCORPIOFS_IMAGE:-gitmono/scorpiofs:ci}"

# The tracked deployment remains human-readable with version tags. CI overlays
# reviewed multi-architecture manifest digests so a tag move cannot change the
# services under test. Mega is already digest-pinned in deploy/compose.yaml.
compose_override="$(mktemp)"
pinned_dockerfile="$(mktemp)"
cat > "$compose_override" <<'YAML'
services:
  postgres:
    image: postgres@sha256:0dda651c259bfe50e2bcc28ca23d1fcca772fa90b0210803aa7b97379ccf4e85
  redis:
    image: redis@sha256:e9b2e45ecd47fbb69b877cf8d045d5cccaaaed52524b6e098b4abe8212994f73
  rustfs:
    image: rustfs/rustfs@sha256:4ee605dfe7c6548d1fa1856357e8a1eccd929e3176acf933fafeba3ce09a69f9
  init-rustfs-bucket:
    image: alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
YAML

sed \
  -e 's|^FROM rust:slim-bookworm AS build$|FROM rust@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3 AS build|' \
  -e 's|^FROM debian:bookworm-slim AS runtime$|FROM debian@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241 AS runtime|' \
  deploy/scorpiofs.Dockerfile > "$pinned_dockerfile"
# The pinned ScorpioFS revision transitively runs bindgen while compiling
# RocksDB. Its upstream Dockerfile omits libclang, so add it only to the
# ephemeral CI build definition without changing the deployment artifact.
sed -i '/^[[:space:]]*pkg-config \\$/a\        libclang-dev \\' "$pinned_dockerfile"
grep -Fx 'FROM rust@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3 AS build' "$pinned_dockerfile" >/dev/null
grep -Fx 'FROM debian@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241 AS runtime' "$pinned_dockerfile" >/dev/null
grep -Fx '        libclang-dev \' "$pinned_dockerfile" >/dev/null

compose=(docker compose --env-file deploy/.env.example -f deploy/compose.yaml -f "$compose_override")

cleanup() {
  status=$?
  if (( status != 0 )); then
    "${compose[@]}" ps --all || true
    "${compose[@]}" logs --no-color --tail 300 postgres redis rustfs init-rustfs-bucket mega || true
  fi
  "${compose[@]}" down --volumes --remove-orphans --timeout 30 >/dev/null 2>&1 || true
  rm -f "$compose_override" "$pinned_dockerfile"
  exit "$status"
}
trap cleanup EXIT

bash scripts/ci/verify-submodules.sh
"${compose[@]}" config --quiet

if [[ "${SKIP_SCORPIO_BUILD:-false}" != "true" ]]; then
  if [[ "${GITHUB_ACTIONS:-false}" == "true" ]]; then
    docker buildx build \
      --file "$pinned_dockerfile" \
      --tag "$SCORPIOFS_IMAGE" \
      --load \
      .
  else
    docker build --file "$pinned_dockerfile" --tag "$SCORPIOFS_IMAGE" .
  fi
fi

# Selecting Mega starts only its prerequisites. --no-build guarantees the
# hosted runner never attempts to launch the FUSE-dependent ScorpioFS service.
"${compose[@]}" up --detach --wait --wait-timeout 360 --no-build mega

mega_status="$(curl --fail --silent --show-error --retry 10 --retry-all-errors --retry-delay 2 \
  http://127.0.0.1:8000/api/v1/status)"
if [[ "$mega_status" != '"http ready"' ]]; then
  echo "Unexpected Mega status response: $mega_status" >&2
  exit 1
fi

init_container="$("${compose[@]}" ps --all --quiet init-rustfs-bucket)"
if [[ -z "$init_container" ]] || [[ "$(docker inspect --format '{{.State.ExitCode}}' "$init_container")" != "0" ]]; then
  echo "RustFS bucket initialization did not finish successfully." >&2
  exit 1
fi
bucket_log="$("${compose[@]}" logs --no-color init-rustfs-bucket)"
if ! grep -Eq 'Bucket init finished \(HTTP (200|201)\)\.' <<<"$bucket_log"; then
  echo "A fresh RustFS volume did not report creating the bucket." >&2
  printf '%s\n' "$bucket_log" >&2
  exit 1
fi

for service in postgres redis rustfs mega; do
  container_id="$("${compose[@]}" ps --quiet "$service")"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")"
  if [[ "$health" != "healthy" ]]; then
    echo "$service is not healthy: $health" >&2
    exit 1
  fi
  if [[ "$(docker inspect --format '{{.RestartCount}}' "$container_id")" != "0" ]]; then
    echo "$service restarted during the smoke test." >&2
    exit 1
  fi
done

"${compose[@]}" exec --no-TTY postgres pg_isready -U postgres -d mono
test "$("${compose[@]}" exec --no-TTY redis redis-cli ping | tr -d '\r')" = "PONG"
"${compose[@]}" exec --no-TTY rustfs curl --fail --silent --show-error http://localhost:9000/health >/dev/null

"${compose[@]}" ps --all
echo "Mega dependency stack and ScorpioFS image smoke checks passed."
