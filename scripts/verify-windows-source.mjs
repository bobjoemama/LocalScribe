#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

const npmExecPath = process.env.npm_execpath;
if (!npmExecPath || !isAbsolute(npmExecPath)) {
  throw new Error("Windows source verification must run through a pinned npm script.");
}
const checks = [
  {
    command: process.execPath,
    arguments_: [
      npmExecPath,
      "ci",
      "--dry-run",
      "--strict-allow-scripts",
      "--os=win32",
      "--cpu=x64",
      "--no-audit",
      "--no-fund",
    ],
    label: "Windows x64 npm clean-install simulation",
  },
  {
    command: "uv",
    arguments_: [
      "sync",
      "--project",
      "worker/windows_transformers",
      "--locked",
      "--no-dev",
      "--no-install-project",
      "--no-build",
      "--python-platform",
      "x86_64-pc-windows-msvc",
      "--python",
      "3.12",
      "--dry-run",
    ],
    label: "Windows x64 Python wheel and lock simulation",
  },
];

for (const { command, arguments_, label } of checks) {
  console.log(`\n${label}`);
  const result = spawnSync(command, arguments_, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("Windows cross-platform source verification passed.");
