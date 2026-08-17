#!/usr/bin/env bash
set -euo pipefail

for command in curl docker git python3; do
  command -v "$command" >/dev/null || {
    echo "Required command is missing: $command" >&2
    exit 1
  }
done

if [[ ! -c /dev/fuse ]]; then
  echo "This runner does not expose /dev/fuse." >&2
  exit 1
fi

if [[ -n "${GITHUB_DEFAULT_BRANCH:-}" ]] && [[ "${GITHUB_REF:-}" != "refs/heads/${GITHUB_DEFAULT_BRANCH}" ]]; then
  echo "FUSE smoke may only execute code from the repository default branch." >&2
  exit 1
fi

project_suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}"
project_suffix="$(printf '%s' "$project_suffix" | tr '[:upper:]_' '[:lower:]-' | tr -cd 'a-z0-9-')"
export COMPOSE_PROJECT_NAME="gitmono-fuse-${project_suffix}"
export SCORPIOFS_IMAGE="${SCORPIOFS_IMAGE:-gitmono/scorpiofs:fuse-ci}"

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
grep -Fx 'FROM rust@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3 AS build' "$pinned_dockerfile" >/dev/null
grep -Fx 'FROM debian@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241 AS runtime' "$pinned_dockerfile" >/dev/null

compose=(docker compose --env-file deploy/.env.example -f deploy/compose.yaml -f "$compose_override")
mount_id=""
response_file=""

cleanup() {
  status=$?
  if [[ -n "$mount_id" ]]; then
    curl --silent --show-error --request DELETE \
      "http://127.0.0.1:2725/antares/mounts/${mount_id}" >/dev/null || true
  fi
  if (( status != 0 )); then
    "${compose[@]}" ps --all || true
    "${compose[@]}" logs --no-color --tail 400 mega scorpiofs || true
  fi
  "${compose[@]}" down --volumes --remove-orphans --timeout 45 >/dev/null 2>&1 || true
  [[ -n "$response_file" ]] && rm -f "$response_file"
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

"${compose[@]}" up --detach --wait --wait-timeout 480 --no-build scorpiofs
bucket_log="$("${compose[@]}" logs --no-color init-rustfs-bucket)"
if ! grep -Eq 'Bucket init finished \(HTTP (200|201)\)\.' <<<"$bucket_log"; then
  echo "A fresh RustFS volume did not report creating the bucket." >&2
  printf '%s\n' "$bucket_log" >&2
  exit 1
fi
test "$(curl --fail --silent --show-error http://127.0.0.1:8000/api/v1/status)" = '"http ready"'
curl --fail --silent --show-error http://127.0.0.1:2725/health >/dev/null
curl --fail --silent --show-error http://127.0.0.1:2725/antares/health >/dev/null
# The service namespace may already overlay the shared workspace with its private
# FUSE submount. Run the writable doctor probe in a fresh sibling namespace.
"${compose[@]}" run --rm --no-deps --no-TTY scorpiofs doctor

mount_path="${SCORPIO_CI_MOUNT_PATH:-/}"
job_id="gitmono-fuse-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}"
payload="$(MOUNT_PATH="$mount_path" JOB_ID="$job_id" python3 - <<'PY'
import json
import os

print(json.dumps({"job_id": os.environ["JOB_ID"], "path": os.environ["MOUNT_PATH"]}))
PY
)"

response_file="$(mktemp)"
curl --fail-with-body --silent --show-error --max-time 180 \
  --retry 2 --retry-all-errors --retry-delay 3 \
  --header 'content-type: application/json' \
  --data "$payload" \
  --output "$response_file" \
  http://127.0.0.1:2725/antares/mounts

mount_id="$(python3 - "$response_file" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
mount_id = data.get("mount_id")
if not isinstance(mount_id, str) or not mount_id:
    raise SystemExit(f"Missing mount_id in response: {data!r}")
print(mount_id)
PY
)"
mountpoint="$(python3 - "$response_file" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
mountpoint = data.get("mountpoint")
if not isinstance(mountpoint, str) or not mountpoint.startswith("/"):
    raise SystemExit(f"Invalid mountpoint in response: {data!r}")
print(mountpoint)
PY
)"
rm -f "$response_file"
response_file=""

ready="false"
for _ in $(seq 1 60); do
  if ready_json="$(curl --fail --silent --show-error --max-time 10 \
    "http://127.0.0.1:2725/antares/mounts/${mount_id}/ready")"; then
    ready="$(READY_JSON="$ready_json" python3 - <<'PY'
import json
import os

try:
    response = json.loads(os.environ["READY_JSON"])
except json.JSONDecodeError:
    response = {}
print("true" if response.get("ready") is True else "false")
PY
)"
  fi
  [[ "$ready" == "true" ]] && break
  sleep 5
done

if [[ "$ready" != "true" ]]; then
  echo "Mount $mount_id did not become ready." >&2
  exit 1
fi

"${compose[@]}" exec --no-TTY -e MOUNTPOINT="$mountpoint" scorpiofs /bin/sh -eu -c '
  grep -F " ${MOUNTPOINT} " /proc/self/mountinfo >/dev/null
  ls -la "${MOUNTPOINT}" >/dev/null
  probe="${MOUNTPOINT}/.gitmono-fuse-smoke"
  printf "fuse-smoke\n" > "${probe}"
  test "$(cat "${probe}")" = "fuse-smoke"
  rm -f "${probe}"
  test ! -e "${probe}"
'

curl --fail --silent --show-error --request DELETE \
  "http://127.0.0.1:2725/antares/mounts/${mount_id}" >/dev/null
mount_id=""
echo "ScorpioFS FUSE mount readiness and read/write smoke checks passed."
