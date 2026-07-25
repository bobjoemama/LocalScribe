#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import "./verify-npm-version.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const expectedNode = readFileSync(path.join(projectRoot, ".nvmrc"), "utf8")
  .trim()
  .replace(/^v/u, "");
const actualNode = process.versions.node;
if (actualNode !== expectedNode) {
  throw new Error(`Node version mismatch: expected ${expectedNode}, received ${actualNode}.`);
}
const expectedUv = readFileSync(path.join(projectRoot, ".uv-version"), "utf8").trim();
if (!/^\d+\.\d+\.\d+$/u.test(expectedUv)) {
  throw new Error(".uv-version must contain one exact semantic version.");
}
const uv = spawnSync("uv", ["--version"], {
  cwd: projectRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
  windowsHide: true,
});
if (uv.error) throw uv.error;
const actualUv = uv.stdout.trim();
const uvMatch = /^uv (\d+\.\d+\.\d+)(?: \([^\r\n]+\))?$/u.exec(actualUv);
if (uv.status !== 0 || uvMatch?.[1] !== expectedUv) {
  throw new Error(`uv version mismatch: expected uv ${expectedUv}, received ${actualUv}.`);
}
process.stdout.write(`Verified Node ${actualNode} and uv ${expectedUv}.\n`);
