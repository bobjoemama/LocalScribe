#!/usr/bin/env bash

set -euo pipefail

app_path="${1:-out/LocalScribe-darwin-arm64/LocalScribe.app}"
app_path="$(cd "$(dirname "$app_path")" && pwd)/$(basename "$app_path")"
asar_path="$app_path/Contents/Resources/app.asar"
executable="$app_path/Contents/MacOS/LocalScribe"

node scripts/verify-packaged-main.mjs "$asar_path"
codesign --verify --deep --strict "$app_path"

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
