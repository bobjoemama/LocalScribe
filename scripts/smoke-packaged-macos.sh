#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
release_json="$(node scripts/release-metadata.mjs --platform darwin --format json)"
default_app_path="$(node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(value.applicationPath)' "$release_json")"
target_arch="$(node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(value.arch)' "$release_json")"
product_name="$(node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(value.productName)' "$release_json")"
app_path="${1:-$default_app_path}"
app_path="$(cd "$(dirname "$app_path")" && pwd)/$(basename "$app_path")"
asar_path="$app_path/Contents/Resources/app.asar"
executable="$app_path/Contents/MacOS/$product_name"

node scripts/verify-packaged-main.mjs "$asar_path"
node scripts/verify-packaged-archive.mjs "$asar_path" darwin "$target_arch"
codesign --verify --deep --strict "$app_path"
node scripts/verify-macos-entitlements.mjs "$app_path"
node scripts/verify-macos-bundle.mjs "$app_path"

smoke_root="$(mktemp -d "${TMPDIR:-/tmp}/localscribe-macos-smoke.XXXXXX")"
profile_path="$smoke_root/profile"
stdout_path="$smoke_root/stdout.log"
stderr_path="$smoke_root/stderr.log"
mkdir -m 700 "$profile_path"

candidate_pid=""
tracked_pids=()

capture_descendants() {
  local root_pid="$1"
  ps -axo pid=,ppid= | awk -v root="$root_pid" '
    {
      pid[NR] = $1
      parent[$1] = $2
    }
    END {
      selected[root] = 1
      changed = 1
      while (changed) {
        changed = 0
        for (row = 1; row <= NR; row += 1) {
          current = pid[row]
          if (!selected[current] && selected[parent[current]]) {
            selected[current] = 1
            changed = 1
          }
        }
      }
      for (row = 1; row <= NR; row += 1) {
        if (pid[row] != root && selected[pid[row]]) print pid[row]
      }
    }
  '
}

tracked_processes_alive() {
  local pid
  for pid in "${tracked_pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

terminate_tracked_processes() {
  local signal="$1"
  local pid
  for pid in "${tracked_pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "-$signal" "$pid" 2>/dev/null || true
    fi
  done
}

cleanup() {
  if tracked_processes_alive; then
    terminate_tracked_processes TERM
    sleep 0.2
    terminate_tracked_processes KILL
  fi
  if [[ -n "$candidate_pid" ]]; then
    wait "$candidate_pid" 2>/dev/null || true
  fi
  find "$smoke_root" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

# LOCALSCRIBE_SMOKE makes the packaged app report startup completion on stdout
# and fail without a modal dialog. Both matter here: a modal NSAlert blocks the
# main thread until dismissed, so an unattended run saw a live process and
# passed a build whose startup had already failed.
LOCALSCRIBE_SMOKE=1 "$executable" "--user-data-dir=$profile_path" >"$stdout_path" 2>"$stderr_path" &
candidate_pid="$!"
sleep 8

if ! kill -0 "$candidate_pid" 2>/dev/null; then
  cat "$stdout_path" "$stderr_path" >&2
  echo "Packaged macOS main process exited during startup." >&2
  exit 1
fi

tracked_pids=("$candidate_pid")
descendants_path="$smoke_root/descendants.txt"
if ! capture_descendants "$candidate_pid" >"$descendants_path"; then
  echo "Packaged macOS smoke could not enumerate the candidate process tree." >&2
  exit 1
fi
while IFS= read -r descendant_pid; do
  if [[ -n "$descendant_pid" ]]; then
    tracked_pids+=("$descendant_pid")
  fi
done <"$descendants_path"

kill -TERM "$candidate_pid"
wait "$candidate_pid" || true
candidate_pid=""

for _ in {1..50}; do
  if ! tracked_processes_alive; then
    break
  fi
  sleep 0.1
done

if tracked_processes_alive; then
  terminate_tracked_processes TERM
  sleep 0.2
  terminate_tracked_processes KILL
  echo "Packaged macOS app left an observed child process running after shutdown." >&2
  exit 1
fi

# A positive assertion. Liveness alone cannot distinguish "started" from
# "blocked in a failure dialog".
if ! grep -Fq 'localscribe-startup-ready' "$stdout_path"; then
  cat "$stdout_path" "$stderr_path" >&2
  echo "Packaged macOS main process never reported a completed startup." >&2
  exit 1
fi

# These patterns are the ones the product actually emits. The previous
# alternation searched for a resource-integrity phrase that appears nowhere
# outside this script, so every resource-integrity failure mode passed the scan.
if grep -Eiq \
  'ERR_INVALID_ARG_VALUE|uncaught exception|javascript error|fatal error|UnhandledPromiseRejection|database connection is not open|LocalScribe startup failed|Resource integrity (rejected|mismatch|is missing|found an unexpected|detected)' \
  "$stdout_path" "$stderr_path"; then
  cat "$stdout_path" "$stderr_path" >&2
  echo "Packaged macOS main process emitted a startup or shutdown error." >&2
  exit 1
fi

echo "Packaged macOS main-process and observed-child shutdown smoke passed."
