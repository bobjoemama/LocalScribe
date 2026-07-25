#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

const npmExecPath = process.env.npm_execpath;
if (!npmExecPath || !isAbsolute(npmExecPath)) {
  throw new Error("Local source verification must run through a pinned npm script.");
}
const checks = [
  ["run", "toolchain:verify"],
  ["run", "audit:production"],
  ["run", "audit:all"],
  ["run", "worker:check-locks"],
  ["run", "audit:python"],
  ["run", "verify:windows:source"],
  ["run", "lint:all"],
  ["run", "worker:test:windows"],
  ["run", "typecheck"],
  ["test", "--", "--reporter=dot"],
];

for (const arguments_ of checks) {
  const result = spawnSync(process.execPath, [npmExecPath, ...arguments_], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("Local source verification passed.");
