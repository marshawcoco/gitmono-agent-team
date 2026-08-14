#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f .gitmodules ]]; then
  echo ".gitmodules is missing." >&2
  exit 1
fi

expected_paths=(submodules/libra submodules/mega submodules/scorpiofs)
expected_urls=(
  https://github.com/libra-tools/libra.git
  https://github.com/gitmono-dev/mega.git
  https://github.com/gitmono-dev/scorpiofs.git
)
mapfile -t submodule_paths < <(git config --file .gitmodules --get-regexp '^submodule\..*\.path$' | awk '{print $2}' | sort)
if [[ "${submodule_paths[*]}" != "${expected_paths[*]}" ]]; then
  echo "Unexpected submodule set: ${submodule_paths[*]}" >&2
  exit 1
fi

for index in "${!expected_paths[@]}"; do
  path="${expected_paths[$index]}"
  name="$path"
  actual_url="$(git config --file .gitmodules --get "submodule.${name}.url")"
  if [[ "$actual_url" != "${expected_urls[$index]}" ]]; then
    echo "Unexpected URL for $path: $actual_url" >&2
    exit 1
  fi
  if [[ "$(git ls-files --stage -- "$path" | awk '{print $1}')" != "160000" ]]; then
    echo "Path is not recorded as a gitlink: $path" >&2
    exit 1
  fi
done

if [[ "${1:-}" == "--metadata-only" ]]; then
  echo "Verified the allowed submodule paths, URLs, and gitlink modes before initialization."
  exit 0
fi
if [[ $# -ne 0 ]]; then
  echo "Usage: $0 [--metadata-only]" >&2
  exit 2
fi

for path in "${expected_paths[@]}"; do
  if [[ ! -e "$path/.git" ]]; then
    echo "Submodule is not initialized: $path" >&2
    exit 1
  fi

  expected_commit="$(git rev-parse "HEAD:$path")"
  actual_commit="$(git -C "$path" rev-parse HEAD)"
  if [[ "$actual_commit" != "$expected_commit" ]]; then
    echo "Submodule commit mismatch for $path: expected $expected_commit, got $actual_commit" >&2
    exit 1
  fi

  if [[ -n "$(git -C "$path" status --porcelain --untracked-files=no)" ]]; then
    echo "Submodule checkout is dirty: $path" >&2
    git -C "$path" status --short >&2
    exit 1
  fi

  printf 'verified %s @ %s\n' "$path" "$actual_commit"
done

if git submodule status --recursive | grep -Eq '^[+-U]'; then
  echo "At least one recursive submodule is missing, divergent, or conflicted." >&2
  git submodule status --recursive >&2
  exit 1
fi

test -f submodules/mega/mono/Dockerfile
test -f submodules/scorpiofs/Dockerfile
test -f submodules/libra/Cargo.toml
