#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

process_group_self_test=0
if [[ "${1:-}" == "--self-test-process-group-anchor" ]]; then
  process_group_self_test=1
  shift
fi

if ((process_group_self_test == 0)); then
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
fi

smoke_root="$(mktemp -d "${TMPDIR:-/tmp}/localscribe-macos-smoke.XXXXXX")"
profile_path="$smoke_root/profile"
stdout_path="$smoke_root/stdout.log"
stderr_path="$smoke_root/stderr.log"
process_group_path="$smoke_root/process-group"
app_pid_path="$smoke_root/app-pid"
app_exit_path="$smoke_root/app-exit"
terminate_app_path="$smoke_root/terminate-app"
release_anchor_path="$smoke_root/release-anchor"
anchor_token="localscribe-smoke-anchor-${smoke_root##*.}"
startup_marker="localscribe-startup-ready"
mkdir -m 700 "$profile_path"

late_child_path=""
if ((process_group_self_test == 1)); then
  executable="$smoke_root/late-child-fixture.sh"
  late_child_path="$smoke_root/late-child-pid"
  cat >"$executable" <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail

: "${LOCALSCRIBE_SMOKE_LATE_CHILD_PATH:?}"
(
  trap '' HUP INT TERM
  sleep 0.75
) &
late_child_pid="$!"
printf '%s\n' "$late_child_pid" >"$LOCALSCRIBE_SMOKE_LATE_CHILD_PATH"
printf '%s\n' 'localscribe-startup-ready'
trap 'exit 0' TERM
while :; do
  sleep 0.05
done
FIXTURE
  chmod 700 "$executable"
fi

candidate_owner_pid=""
candidate_process_group=""
candidate_anchor_pid=""
candidate_app_pid=""

owned_process_group_anchored() {
  [[ -n "$candidate_process_group" ]] || return 1
  [[ -n "$candidate_anchor_pid" ]] || return 1
  [[ "$candidate_process_group" == "$candidate_anchor_pid" ]] || return 1

  local actual_process_group anchor_command
  actual_process_group="$(
    ps -o pgid= -p "$candidate_anchor_pid" 2>/dev/null | tr -d '[:space:]' || true
  )"
  [[ "$actual_process_group" == "$candidate_process_group" ]] || return 1
  anchor_command="$(ps -o command= -p "$candidate_anchor_pid" 2>/dev/null || true)"
  [[ "$anchor_command" == *"$anchor_token"* ]]
}

owned_non_anchor_members() {
  owned_process_group_anchored || return 2
  ps -axo pid=,pgid= | awk \
    -v process_group="$candidate_process_group" \
    -v anchor_pid="$candidate_anchor_pid" \
    '$2 == process_group && $1 != anchor_pid { print $1 }'
}

owned_non_anchor_members_alive() {
  local members
  members="$(owned_non_anchor_members)" || return 2
  [[ -n "$members" ]]
}

signal_owned_application() {
  local signal="$1"
  [[ "$signal" == "TERM" ]] || return 1
  owned_process_group_anchored || return 1
  [[ -n "$candidate_app_pid" ]] || return 1

  local actual_process_group
  actual_process_group="$(
    ps -o pgid= -p "$candidate_app_pid" 2>/dev/null | tr -d '[:space:]' || true
  )"
  [[ "$actual_process_group" == "$candidate_process_group" ]] || return 1
  : >"$terminate_app_path"
}

signal_owned_process_group() {
  local signal="$1"
  owned_process_group_anchored || return 1
  kill "-$signal" -- "-$candidate_process_group"
}

release_owned_anchor() {
  owned_process_group_anchored || return 1
  : >"$release_anchor_path"
}

kill_owned_process_group() {
  if owned_process_group_anchored; then
    # The anchor makes this negative-pgid signal unambiguous at the instant it
    # is sent. Clear the identity immediately: consulting that former pgid
    # after SIGKILL would risk observing a later, unrelated process group.
    kill -KILL -- "-$candidate_process_group" 2>/dev/null || true
  fi
  candidate_process_group=""
  candidate_anchor_pid=""
  candidate_app_pid=""
}

cleanup() {
  if owned_process_group_anchored; then
    signal_owned_process_group TERM 2>/dev/null || true
    for _ in {1..20}; do
      owned_process_group_anchored || break
      if ! owned_non_anchor_members_alive; then
        break
      fi
      sleep 0.05
    done
    if owned_process_group_anchored; then
      if owned_non_anchor_members_alive; then
        kill_owned_process_group
      else
        release_owned_anchor 2>/dev/null || true
      fi
    fi
  fi
  if [[ -n "$candidate_owner_pid" ]]; then
    for _ in {1..20}; do
      kill -0 "$candidate_owner_pid" 2>/dev/null || break
      sleep 0.05
    done
    if kill -0 "$candidate_owner_pid" 2>/dev/null; then
      kill -KILL "$candidate_owner_pid" 2>/dev/null || true
    fi
    wait "$candidate_owner_pid" 2>/dev/null || true
  fi
  find "$smoke_root" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

# LOCALSCRIBE_SMOKE makes the packaged app report startup completion on stdout
# and fail without a modal dialog. The first Node process is a shell-owned
# waiter. It creates a detached Node anchor, which remains the exclusive live
# leader of the candidate's process group while the app and every inherited
# child run inside that group. The anchor records the app's exit but does not
# retire until the shell has proved no non-anchor group member remains. This
# avoids consulting or signaling a stale former-leader pgid after app exit.
LOCALSCRIBE_SMOKE_LATE_CHILD_PATH="$late_child_path" \
node --input-type=module - \
  "$executable" "$profile_path" "$stdout_path" "$stderr_path" \
  "$process_group_path" "$app_pid_path" "$app_exit_path" "$terminate_app_path" \
  "$release_anchor_path" "$anchor_token" <<'NODE' &
import { closeSync, openSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [
  executable,
  profilePath,
  stdoutPath,
  stderrPath,
  processGroupPath,
  appPidPath,
  appExitPath,
  terminateAppPath,
  releaseAnchorPath,
  anchorToken,
] = process.argv.slice(2);

const anchorSource = String.raw`
const { existsSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");

const [
  anchorToken,
  executable,
  profilePath,
  appPidPath,
  appExitPath,
  terminateAppPath,
  releaseAnchorPath,
] = process.argv.slice(1);

process.title = anchorToken;
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});

const wait = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

async function main() {
  const child = spawn(executable, ["--user-data-dir=" + profilePath], {
    detached: false,
    env: { ...process.env, LOCALSCRIBE_SMOKE: "1" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
    throw new Error("Packaged macOS smoke received an unsafe app process id.");
  }
  writeFileSync(appPidPath, String(child.pid) + "\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  let terminationRequested = false;
  const terminationWatcher = setInterval(() => {
    if (terminationRequested || !existsSync(terminateAppPath)) return;
    terminationRequested = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }, 10);
  const outcome = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearInterval(terminationWatcher);
  writeFileSync(appExitPath, JSON.stringify(outcome) + "\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  while (!existsSync(releaseAnchorPath)) {
    await wait(25);
  }
}

void main().catch((error) => {
  console.error("Packaged macOS smoke anchor failed:", error);
  process.exitCode = 1;
});
`;

const stdout = openSync(stdoutPath, "wx", 0o600);
const stderr = openSync(stderrPath, "wx", 0o600);
let anchor;
try {
  anchor = spawn(process.execPath, [
    "-e",
    anchorSource,
    anchorToken,
    executable,
    profilePath,
    appPidPath,
    appExitPath,
    terminateAppPath,
    releaseAnchorPath,
  ], {
    detached: true,
    env: process.env,
    stdio: ["ignore", stdout, stderr],
  });
  await new Promise((resolve, reject) => {
    anchor.once("spawn", resolve);
    anchor.once("error", reject);
  });
  if (!Number.isSafeInteger(anchor.pid) || anchor.pid <= 1) {
    throw new Error("Packaged macOS smoke received an unsafe anchor process id.");
  }
  writeFileSync(processGroupPath, `${anchor.pid}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
} finally {
  closeSync(stdout);
  closeSync(stderr);
}

const outcome = await new Promise((resolve, reject) => {
  anchor.once("error", reject);
  anchor.once("exit", (code, signal) => resolve({ code, signal }));
});
process.exitCode = outcome.code ?? (outcome.signal === "SIGTERM" ? 143 : 1);
NODE
candidate_owner_pid="$!"

for _ in {1..100}; do
  if [[ -s "$process_group_path" && -s "$app_pid_path" ]]; then
    break
  fi
  if ! kill -0 "$candidate_owner_pid" 2>/dev/null; then
    break
  fi
  sleep 0.05
done
if [[ ! -s "$process_group_path" || ! -s "$app_pid_path" ]]; then
  cat "$stdout_path" "$stderr_path" >&2 2>/dev/null || true
  echo "Packaged macOS smoke could not start its owned process group." >&2
  exit 1
fi
IFS= read -r candidate_process_group <"$process_group_path"
candidate_anchor_pid="$candidate_process_group"
IFS= read -r candidate_app_pid <"$app_pid_path"
if [[ ! "$candidate_process_group" =~ ^[0-9]+$ ]] || ((candidate_process_group <= 1)); then
  echo "Packaged macOS smoke received an unsafe process-group id." >&2
  exit 1
fi
if [[ ! "$candidate_app_pid" =~ ^[0-9]+$ ]] || ((candidate_app_pid <= 1)); then
  echo "Packaged macOS smoke received an unsafe app process id." >&2
  exit 1
fi
if ! owned_process_group_anchored; then
  cat "$stdout_path" "$stderr_path" >&2
  echo "Packaged macOS smoke lost its live process-group ownership anchor." >&2
  exit 1
fi
actual_app_process_group="$(
  ps -o pgid= -p "$candidate_app_pid" 2>/dev/null | tr -d '[:space:]' || true
)"
if [[ "$actual_app_process_group" != "$candidate_process_group" ]]; then
  cat "$stdout_path" "$stderr_path" >&2
  echo "Packaged macOS executable did not join its owned process group." >&2
  exit 1
fi

for _ in {1..80}; do
  if grep -Fq "$startup_marker" "$stdout_path"; then
    break
  fi
  if [[ -e "$app_exit_path" ]] || ! owned_process_group_anchored; then
    cat "$stdout_path" "$stderr_path" >&2
    echo "Packaged macOS main process exited during startup." >&2
    exit 1
  fi
  sleep 0.1
done

# Signal only the app first. Its anchor remains alive and owns the process group
# throughout the app's shutdown and any late-child retirement.
if ! signal_owned_application TERM; then
  cat "$stdout_path" "$stderr_path" >&2
  echo "Packaged macOS smoke could not signal its owned application." >&2
  exit 1
fi

for _ in {1..50}; do
  [[ -e "$app_exit_path" ]] && break
  if ! owned_process_group_anchored; then
    cat "$stdout_path" "$stderr_path" >&2
    echo "Packaged macOS smoke lost its ownership anchor during shutdown." >&2
    exit 1
  fi
  sleep 0.1
done
if [[ ! -e "$app_exit_path" ]]; then
  echo "Packaged macOS app leader did not exit after shutdown." >&2
  exit 1
fi

if ((process_group_self_test == 1)); then
  for _ in {1..20}; do
    [[ -s "$late_child_path" ]] && break
    sleep 0.01
  done
  if [[ ! -s "$late_child_path" ]]; then
    echo "Process-group anchor regression did not record its late child." >&2
    exit 1
  fi
  IFS= read -r late_child_pid <"$late_child_path"
  late_child_process_group="$(
    ps -o pgid= -p "$late_child_pid" 2>/dev/null | tr -d '[:space:]' || true
  )"
  if [[ "$late_child_process_group" != "$candidate_process_group" ]]; then
    echo "Process-group anchor regression lost the late child before inspection." >&2
    exit 1
  fi
fi

for _ in {1..50}; do
  if ! owned_process_group_anchored; then
    echo "Packaged macOS smoke lost its ownership anchor before teardown completed." >&2
    exit 1
  fi
  if ! owned_non_anchor_members_alive; then
    break
  fi
  sleep 0.1
done

if owned_non_anchor_members_alive; then
  kill_owned_process_group
  wait "$candidate_owner_pid" 2>/dev/null || true
  candidate_owner_pid=""
  echo "Packaged macOS app left a process running in its owned group after shutdown." >&2
  exit 1
fi

release_owned_anchor
wait "$candidate_owner_pid"
candidate_owner_pid=""
candidate_process_group=""
candidate_anchor_pid=""
candidate_app_pid=""

# A positive assertion. Liveness alone cannot distinguish "started" from
# "blocked in a failure dialog".
if ! grep -Fq "$startup_marker" "$stdout_path"; then
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

if ((process_group_self_test == 1)); then
  echo "Process-group anchor regression passed: app leader exited before late child teardown."
else
  echo "Packaged macOS main-process and anchored-process-group shutdown smoke passed."
fi
