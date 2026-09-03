#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path, { isAbsolute } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertReleaseInputsGitTracked } from "./package-provenance.mts";

export const RELEASE_CANDIDATE_ARGUMENT = "--release-candidate";

/**
 * The platform-independent gate suite, in the order it runs. This is what
 * `npm run ci` and the `.githooks/pre-push` hook execute, and what a release
 * candidate must pass before the macOS-only gates in `verify-local-macos.sh`.
 *
 * Exported so `tests/ciPipeline.test.ts` can assert the pipeline still covers
 * every gate it is supposed to. Dropping a check here is a silent loss of
 * coverage otherwise — nothing else would notice.
 */
export const SOURCE_VERIFICATION_CHECKS = Object.freeze([
  Object.freeze(["run", "toolchain:verify"]),
  Object.freeze(["run", "audit:production"]),
  Object.freeze(["run", "audit:all"]),
  Object.freeze(["run", "worker:check-locks"]),
  Object.freeze(["run", "audit:python"]),
  Object.freeze(["run", "lint:all"]),
  Object.freeze(["run", "typecheck"]),
  Object.freeze(["test", "--", "--reporter=dot"]),
]);

export function releaseCandidateModeFromArguments(arguments_) {
  if (arguments_.length === 0) return false;
  if (arguments_.length === 1 && arguments_[0] === RELEASE_CANDIDATE_ARGUMENT) return true;
  throw new Error(
    `Unknown local source verification argument(s): ${arguments_.join(" ")}`,
  );
}

export function assertReleaseCandidateGitState(
  projectPath = process.cwd(),
  inputCandidates,
) {
  assertReleaseInputsGitTracked({
    projectPath,
    platform: "darwin",
    inputCandidates,
  });

  const status = spawnSync(
    "git",
    ["-C", projectPath, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (status.error) throw status.error;
  if (status.status !== 0) {
    throw new Error("Release-candidate verification could not inspect Git worktree state.");
  }
  const changedPathCount = status.stdout.split("\0").filter(Boolean).length;
  if (changedPathCount > 0) {
    throw new Error(
      `Release-candidate verification requires a clean Git worktree; found ${changedPathCount} changed or untracked path(s).`,
    );
  }
}

function runSourceVerification({ releaseCandidate = false } = {}) {
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath || !isAbsolute(npmExecPath)) {
    throw new Error("Local source verification must run through a pinned npm script.");
  }

  if (releaseCandidate) assertReleaseCandidateGitState();

  for (const arguments_ of SOURCE_VERIFICATION_CHECKS) {
    const result = spawnSync(process.execPath, [npmExecPath, ...arguments_], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }

  console.log("Local source verification passed.");
}

/*
 * Importing this module must not run the pipeline; only invoking it directly
 * should. Without this guard a test that imports the check list would spawn the
 * entire suite recursively.
 */
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runSourceVerification({
    releaseCandidate: releaseCandidateModeFromArguments(process.argv.slice(2)),
  });
}
