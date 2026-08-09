#!/usr/bin/env node

import { verifyReleaseAssets } from "./release-assets.mts";

const arguments_ = process.argv.slice(2);
const platformIndex = arguments_.indexOf("--platform");
const platform = platformIndex >= 0 ? arguments_[platformIndex + 1] : undefined;
const requirePrerelease = arguments_.includes("--require-prerelease");
const candidate = arguments_.includes("--candidate");
const recognized = new Set([
  "--platform",
  ...(platformIndex >= 0 && platform ? [platform] : []),
  ...(requirePrerelease ? ["--require-prerelease"] : []),
  ...(candidate ? ["--candidate"] : []),
]);
const unknown = arguments_.filter((argument) => !recognized.has(argument));
if (platform !== "darwin" && platform !== "win32") {
  throw new Error(
    "Usage: verify-release-assets.mjs --platform <darwin|win32> [--candidate] [--require-prerelease]",
  );
}
if (unknown.length > 0) {
  throw new Error(`Unknown release verification arguments: ${unknown.join(", ")}`);
}
const result = await verifyReleaseAssets(
  platform,
  process.cwd(),
  candidate ? "candidate" : "publication",
);
if (requirePrerelease && !result.prerelease) {
  throw new Error(
    `Release ${result.tag} is not a semantic-version prerelease; refusing a prerelease upload.`,
  );
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
