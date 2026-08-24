#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const TEST_RUN_DEADLINE_MS = 3 * 60_000;
export const TEST_RUN_TERM_GRACE_MS = 5_000;
const PROCESS_GROUP_POLL_MS = 50;

function isErrno(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Only a detached direct child with a safe positive pid may become a group target. */
export function processGroupIdForChild(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    throw new Error("Bounded test runner received an unsafe child process id.");
  }
  return pid;
}

export function processGroupIsAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (!isErrno(error, "ESRCH")) throw error;
  }
}

async function waitForProcessGroupExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupIsAlive(processGroupId)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(PROCESS_GROUP_POLL_MS, remaining));
  }
  return true;
}

function testLockPath(projectPath) {
  const identity = createHash("sha256").update(path.resolve(projectPath)).digest("hex").slice(0, 16);
  return path.join(tmpdir(), `localscribe-vitest-${identity}.lock`);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

/** Prevent two expensive suites from accidentally running against one checkout. */
function acquireTestLock(projectPath) {
  const lockPath = testLockPath(projectPath);
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, token })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      return () => {
        try {
          const owner = JSON.parse(readFileSync(path.join(lockPath, "owner.json"), "utf8"));
          if (owner.token === token) rmSync(lockPath, { recursive: true });
        } catch {
          // A signal or external cleanup may already have removed the exact lock.
        }
      };
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      let ownerPid = 0;
      try {
        const owner = JSON.parse(readFileSync(path.join(lockPath, "owner.json"), "utf8"));
        ownerPid = owner.pid;
      } catch {
        // An incomplete lock has no live owner and is stale.
      }
      if (processIsAlive(ownerPid)) {
        throw new Error(
          `A LocalScribe test suite is already running for this checkout (PID ${ownerPid}).`,
          { cause: error },
        );
      }
      rmSync(lockPath, { recursive: true });
    }
  }
  throw new Error("Could not acquire the LocalScribe test-suite lock.");
}

function resolveVitestCli() {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("vitest/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const relativeCli = manifest.bin?.vitest;
  if (typeof relativeCli !== "string" || path.isAbsolute(relativeCli) || relativeCli.includes("..")) {
    throw new Error("The pinned Vitest package declares an unsafe CLI path.");
  }
  return path.resolve(path.dirname(manifestPath), relativeCli);
}

async function run() {
  if (process.platform === "win32") {
    throw new Error("The bounded LocalScribe test runner currently requires POSIX process groups.");
  }
  const releaseLock = acquireTestLock(process.cwd());
  let child;
  let processGroupId;
  let timedOut = false;
  let interruptedSignal = null;
  let deadlineTimer;

  const forwardSignal = (signal) => {
    interruptedSignal = signal;
    if (processGroupId !== undefined) signalProcessGroup(processGroupId, signal);
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    child = spawn(process.execPath, [resolveVitestCli(), "run", ...process.argv.slice(2)], {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: "inherit",
    });
    processGroupId = processGroupIdForChild(child.pid);
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      process.stderr.write(
        `LocalScribe test suite exceeded ${TEST_RUN_DEADLINE_MS}ms; terminating process group ${processGroupId}.\n`,
      );
      signalProcessGroup(processGroupId, "SIGTERM");
    }, TEST_RUN_DEADLINE_MS);
    deadlineTimer.unref();

    const outcome = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (deadlineTimer) clearTimeout(deadlineTimer);

    let cleanGroupExit = await waitForProcessGroupExit(processGroupId, TEST_RUN_TERM_GRACE_MS);
    if (!cleanGroupExit) {
      signalProcessGroup(processGroupId, "SIGTERM");
      cleanGroupExit = await waitForProcessGroupExit(processGroupId, TEST_RUN_TERM_GRACE_MS);
    }
    if (!cleanGroupExit) {
      signalProcessGroup(processGroupId, "SIGKILL");
      cleanGroupExit = await waitForProcessGroupExit(processGroupId, TEST_RUN_TERM_GRACE_MS);
    }
    if (!cleanGroupExit) {
      throw new Error(`Vitest process group ${processGroupId} survived SIGKILL.`);
    }
    if (timedOut) process.exitCode = 124;
    else if (interruptedSignal) process.exitCode = interruptedSignal === "SIGINT" ? 130 : 143;
    else process.exitCode = outcome.code ?? 1;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (processGroupId !== undefined && processGroupIsAlive(processGroupId)) {
      signalProcessGroup(processGroupId, "SIGKILL");
      await waitForProcessGroupExit(processGroupId, TEST_RUN_TERM_GRACE_MS);
    }
    releaseLock();
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
