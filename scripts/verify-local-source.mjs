#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const checks = [
  ["run", "toolchain:verify:npm"],
  ["run", "audit:production"],
  ["run", "audit:all"],
  ["run", "worker:check-locks"],
  ["run", "audit:python"],
  ["run", "lint:all"],
  ["run", "typecheck"],
  ["test", "--", "--reporter=dot"],
];

for (const arguments_ of checks) {
  const result = spawnSync(npmExecutable, arguments_, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("Local source verification passed.");
