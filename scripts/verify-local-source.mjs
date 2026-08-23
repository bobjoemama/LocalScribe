#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path, { isAbsolute } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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

function runSourceVerification() {
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath || !isAbsolute(npmExecPath)) {
    throw new Error("Local source verification must run through a pinned npm script.");
  }

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
if (invokedPath === fileURLToPath(import.meta.url)) runSourceVerification();
