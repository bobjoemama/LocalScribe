#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  closeSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

const MACH_O_MAGICS = new Set([
  "feedface",
  "feedfacf",
  "cefaedfe",
  "cffaedfe",
  "cafebabe",
  "cafebabf",
  "bebafeca",
  "bfbafeca",
]);

function fail(message) {
  throw new Error(`macOS entitlement verification failed: ${message}`);
}

function isMachO(filePath) {
  const descriptor = openSync(filePath, "r");
  try {
    const magic = Buffer.alloc(4);
    return readSync(descriptor, magic, 0, magic.length, 0) === magic.length &&
      MACH_O_MAGICS.has(magic.toString("hex"));
  } finally {
    closeSync(descriptor);
  }
}

function collectMachOFiles(root) {
  const files = [];
  const visit = (candidate) => {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const child of readdirSync(candidate).sort()) {
        visit(path.join(candidate, child));
      }
      return;
    }
    if (stat.isFile() && isMachO(candidate)) files.push(candidate);
  };
  visit(root);
  return files;
}

function entitlements(filePath) {
  try {
    return execFileSync(
      "codesign",
      ["-d", "--entitlements", ":-", filePath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error
      ? String(error.stderr)
      : "";
    fail(`${filePath} could not be inspected${stderr ? `: ${stderr.trim()}` : ""}`);
  }
}

function assertNoEntitlementKeys(filePath) {
  const plist = entitlements(filePath);
  if (plist.includes("<key>")) {
    fail(`${filePath} unexpectedly carries privileged entitlements:\n${plist}`);
  }
}

const appPath = path.resolve(process.argv[2] ?? "out/LocalScribe-darwin-arm64/LocalScribe.app");
const resourcesPath = path.join(appPath, "Contents", "Resources");
const activeTarget = path.join(resourcesPath, "native", "macos", "active-target");
const runtimeRoot = path.join(resourcesPath, "python-runtime");
const appEntitlements = entitlements(appPath);

for (const required of [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.device.audio-input",
]) {
  if (!appEntitlements.includes(`<key>${required}</key>`)) {
    fail(`the main app is missing ${required}`);
  }
}

assertNoEntitlementKeys(activeTarget);
const runtimeMachOFiles = collectMachOFiles(runtimeRoot);
if (runtimeMachOFiles.length === 0) fail("the packaged Python runtime contains no Mach-O files");
for (const binary of runtimeMachOFiles) assertNoEntitlementKeys(binary);

console.log(
  `macOS entitlements verified: main app capabilities present; active-target and ${runtimeMachOFiles.length} runtime Mach-O files are unprivileged.`,
);
