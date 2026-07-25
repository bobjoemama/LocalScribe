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
cleanup() {
  if [[ -n "$candidate_pid" ]] && kill -0 "$candidate_pid" 2>/dev/null; then
    kill -TERM "$candidate_pid" 2>/dev/null || true
    wait "$candidate_pid" 2>/dev/null || true
  fi
  find "$smoke_root" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

"$executable" "--user-data-dir=$profile_path" >"$stdout_path" 2>"$stderr_path" &
candidate_pid="$!"
sleep 8

if ! kill -0 "$candidate_pid" 2>/dev/null; then
  cat "$stdout_path" "$stderr_path" >&2
  echo "Packaged macOS main process exited during startup." >&2
  exit 1
fi

kill -TERM "$candidate_pid"
wait "$candidate_pid" || true
candidate_pid=""

if grep -Eiq \
  'ERR_INVALID_ARG_VALUE|uncaught exception|javascript error|resource integrity verification failed|fatal error|UnhandledPromiseRejection|database connection is not open' \
  "$stdout_path" "$stderr_path"; then
  cat "$stdout_path" "$stderr_path" >&2
  echo "Packaged macOS main process emitted a startup or shutdown error." >&2
  exit 1
fi

echo "Packaged macOS main-process smoke passed."
