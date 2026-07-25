#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  loadReleaseMetadata,
  releaseLayout,
} from "./release-metadata.mts";

const RELEASE_METADATA = loadReleaseMetadata();
const RELEASE_LAYOUT = releaseLayout(RELEASE_METADATA, "darwin");

function fail(message) {
  throw new Error(`macOS artifact verification failed: ${message}`);
}

function requireFile(filePath, label) {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    fail(`${label} does not exist: ${resolved}`);
  }
  return resolved;
}

function requireApp(appPath, label) {
  const resolved = path.resolve(appPath);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    fail(`${label} does not exist: ${resolved}`);
  }
  return resolved;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function codeDirectoryHash(appPath) {
  const result = spawnSync("codesign", ["-dv", "--verbose=4", appPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`could not inspect code signature for ${appPath}: ${result.stderr.trim()}`);
  }
  const match = `${result.stdout}\n${result.stderr}`.match(/^CDHash=([a-f0-9]+)$/imu);
  if (!match?.[1]) fail(`code signature for ${appPath} has no CDHash`);
  return match[1];
}

function verifyApp(appPath, expectedCodeHash, expectedAsarHash, publicRelease) {
  const arguments_ = [
    path.resolve("scripts/verify-macos-bundle.mjs"),
    appPath,
    ...(publicRelease ? ["--public-release"] : []),
  ];
  execFileSync(process.execPath, arguments_, { stdio: "inherit" });
  execFileSync(
    process.execPath,
    [
      path.resolve("scripts/verify-packaged-main.mjs"),
      path.join(appPath, "Contents", "Resources", "app.asar"),
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    process.execPath,
    [
      path.resolve("scripts/verify-packaged-archive.mjs"),
      path.join(appPath, "Contents", "Resources", "app.asar"),
      "darwin",
      RELEASE_LAYOUT.target.arch,
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    process.execPath,
    [path.resolve("scripts/verify-macos-entitlements.mjs"), appPath],
    { stdio: "inherit" },
  );
  if (codeDirectoryHash(appPath) !== expectedCodeHash) {
    fail(`${appPath} does not carry the exact staged app code signature`);
  }
  const asarHash = sha256(path.join(appPath, "Contents", "Resources", "app.asar"));
  if (asarHash !== expectedAsarHash) {
    fail(`${appPath} does not carry the exact staged app.asar`);
  }
}

function safeCleanup(directory) {
  const resolved = path.resolve(directory);
  const temporaryRoot = path.resolve(tmpdir());
  if (
    resolved === temporaryRoot ||
    !resolved.startsWith(`${temporaryRoot}${path.sep}`) ||
    !path.basename(resolved).startsWith("localscribe-macos-artifacts-")
  ) {
    fail(`refusing to clean unexpected temporary path: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true });
}

const arguments_ = process.argv.slice(2);
const publicRelease = arguments_.includes("--public-release");
const positional = arguments_.filter((argument) => argument !== "--public-release");
if (positional.length !== 3) {
  throw new Error(
    "Usage: node scripts/verify-macos-artifacts.mjs " +
      "<staged.app> <installer.dmg> <portable.zip> [--public-release]",
  );
}
if (process.platform !== "darwin") fail("verification must run on macOS");

const stagedApp = requireApp(positional[0], "staged app");
const dmgPath = requireFile(positional[1], "DMG");
const zipPath = requireFile(positional[2], "ZIP");
const expectedCodeHash = codeDirectoryHash(stagedApp);
const expectedAsarHash = sha256(
  path.join(stagedApp, "Contents", "Resources", "app.asar"),
);
verifyApp(stagedApp, expectedCodeHash, expectedAsarHash, publicRelease);

const temporaryRoot = mkdtempSync(
  path.join(tmpdir(), "localscribe-macos-artifacts-"),
);
const mountPath = path.join(temporaryRoot, "dmg");
const zipExtractPath = path.join(temporaryRoot, "zip");
mkdirSync(mountPath, { mode: 0o700 });
mkdirSync(zipExtractPath, { mode: 0o700 });
let mounted = false;

try {
  execFileSync(
    "hdiutil",
    [
      "attach",
      "-readonly",
      "-nobrowse",
      "-noautoopen",
      "-mountpoint",
      mountPath,
      dmgPath,
    ],
    { stdio: "inherit" },
  );
  mounted = true;
  const dmgEntries = readdirSync(mountPath).sort();
  const allowedDmgEntries = new Set([
    ".background",
    ".DS_Store",
    ".VolumeIcon.icns",
    "Applications",
    RELEASE_LAYOUT.applicationName,
  ]);
  const unexpectedDmgEntries = dmgEntries.filter((entry) => !allowedDmgEntries.has(entry));
  if (unexpectedDmgEntries.length > 0) {
    fail(`DMG has unexpected top-level entries: ${unexpectedDmgEntries.join(", ")}`);
  }
  for (const required of ["Applications", RELEASE_LAYOUT.applicationName]) {
    if (!dmgEntries.includes(required)) {
      fail(`DMG is missing ${required}`);
    }
  }
  const applicationsLink = path.join(mountPath, "Applications");
  if (
    !lstatSync(applicationsLink).isSymbolicLink() ||
    readlinkSync(applicationsLink) !== "/Applications"
  ) {
    fail("DMG Applications entry is not a link to /Applications");
  }
  verifyApp(
    path.join(mountPath, RELEASE_LAYOUT.applicationName),
    expectedCodeHash,
    expectedAsarHash,
    publicRelease,
  );
  execFileSync("hdiutil", ["detach", mountPath], { stdio: "inherit" });
  mounted = false;

  execFileSync("ditto", ["-x", "-k", zipPath, zipExtractPath], {
    stdio: "inherit",
  });
  const zipEntries = readdirSync(zipExtractPath)
    .filter((entry) => entry !== "__MACOSX")
    .sort();
  if (
    zipEntries.length !== 1 ||
    zipEntries[0] !== RELEASE_LAYOUT.applicationName
  ) {
    fail(
      `ZIP top-level entries are [${zipEntries.join(", ")}], ` +
      `expected [${RELEASE_LAYOUT.applicationName}]`,
    );
  }
  verifyApp(
    path.join(zipExtractPath, RELEASE_LAYOUT.applicationName),
    expectedCodeHash,
    expectedAsarHash,
    publicRelease,
  );
} finally {
  if (mounted) {
    try {
      execFileSync("hdiutil", ["detach", mountPath], { stdio: "ignore" });
      mounted = false;
    } catch {
      // Preserve the original verification error. The temporary path remains
      // private and the mounted image is read-only.
    }
  }
  if (!mounted) safeCleanup(temporaryRoot);
}

console.log(
  `macOS DMG and ZIP verified as exact, signed copies of ${stagedApp}.`,
);
