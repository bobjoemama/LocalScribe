#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { loadReleaseMetadata } from "./release-metadata.mts";

const arguments_ = process.argv.slice(2);
const [action, platform] = arguments_;
if (
  arguments_.length !== 2 ||
  (action !== "package" && action !== "make") ||
  (platform !== "darwin" && platform !== "win32")
) {
  throw new Error("Usage: run-forge-target.mjs <package|make> <darwin|win32>");
}
if (process.platform !== platform) {
  throw new Error(
    `The ${platform} release target must be built on ${platform}; current host is ${process.platform}.`,
  );
}
const metadata = loadReleaseMetadata();
const target = metadata.targets[platform];
const require = createRequire(import.meta.url);
const forgeCli = require.resolve("@electron-forge/cli/dist/electron-forge.js");
const result = spawnSync(
  process.execPath,
  [forgeCli, action, `--platform=${platform}`, `--arch=${target.arch}`],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
