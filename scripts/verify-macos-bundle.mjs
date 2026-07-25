#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getRawHeader } from "@electron/asar";
import {
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
} from "@electron/fuses";
import {
  loadReleaseMetadata,
  releaseLayout,
} from "./release-metadata.mts";

const FUSE_DISABLED = 0x30;
const FUSE_ENABLED = 0x31;
const RELEASE_METADATA = loadReleaseMetadata();
const RELEASE_LAYOUT = releaseLayout(RELEASE_METADATA, "darwin");

function fail(message) {
  throw new Error(`macOS bundle verification failed: ${message}`);
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function readInfoPlist(infoPlistPath) {
  try {
    return JSON.parse(
      execFileSync(
        "plutil",
        ["-convert", "json", "-o", "-", infoPlistPath],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error
      ? String(error.stderr).trim()
      : "";
    fail(`could not parse Info.plist${stderr ? `: ${stderr}` : ""}`);
  }
}

function assertValue(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

async function assertFuses(appPath) {
  const fuses = await getCurrentFuseWire(appPath);
  assertValue(fuses.version, FuseVersion.V1, "Electron fuse schema");
  const expectations = new Map([
    [FuseV1Options.RunAsNode, FUSE_DISABLED],
    [FuseV1Options.EnableCookieEncryption, FUSE_ENABLED],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FUSE_DISABLED],
    [FuseV1Options.EnableNodeCliInspectArguments, FUSE_DISABLED],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FUSE_ENABLED],
    [FuseV1Options.OnlyLoadAppFromAsar, FUSE_ENABLED],
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FUSE_DISABLED],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, FUSE_DISABLED],
  ]);
  for (const [fuse, expected] of expectations) {
    assertValue(fuses[fuse], expected, `Electron fuse ${FuseV1Options[fuse]}`);
  }
}

function assertCodeSignature(appPath, publicRelease) {
  execFileSync(
    "codesign",
    ["--verify", "--deep", "--strict", "--verbose=4", appPath],
    { stdio: "inherit" },
  );
  const result = spawnSync(
    "codesign",
    ["-dv", "--verbose=4", appPath],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`could not inspect code signature: ${result.stderr.trim()}`);
  }
  const details = `${result.stdout}\n${result.stderr}`;
  if (publicRelease) {
    if (!details.includes("Authority=Developer ID Application:")) {
      fail("public release is not signed by a Developer ID Application identity");
    }
    if (!/flags=0x[0-9a-f]+\(runtime\)/iu.test(details)) {
      fail("public release is missing hardened-runtime signature flags");
    }
  }
}

const arguments_ = process.argv.slice(2);
const publicRelease = arguments_.includes("--public-release");
const appArgument = arguments_.find((argument) => argument !== "--public-release");
const appPath = path.resolve(
  appArgument ?? RELEASE_LAYOUT.applicationPath,
);
if (process.platform !== "darwin") {
  fail("verification must run on macOS");
}
if (!existsSync(appPath) || !statSync(appPath).isDirectory()) {
  fail(`app bundle does not exist: ${appPath}`);
}

const contentsPath = path.join(appPath, "Contents");
const resourcesPath = path.join(contentsPath, "Resources");
const infoPlistPath = path.join(contentsPath, "Info.plist");
const executablePath = path.join(contentsPath, "MacOS", RELEASE_METADATA.productName);
const asarPath = path.join(resourcesPath, "app.asar");
const info = readInfoPlist(infoPlistPath);

assertValue(info.CFBundleIdentifier, RELEASE_METADATA.macBundleId, "CFBundleIdentifier");
assertValue(
  info.CFBundleDisplayName,
  RELEASE_METADATA.productName,
  "CFBundleDisplayName",
);
assertValue(
  info.CFBundleExecutable,
  RELEASE_METADATA.productName,
  "CFBundleExecutable",
);
assertValue(
  info.CFBundleShortVersionString,
  RELEASE_METADATA.version,
  "CFBundleShortVersionString",
);
assertValue(info.CFBundleVersion, RELEASE_METADATA.version, "CFBundleVersion");
assertValue(
  info.LSMinimumSystemVersion,
  RELEASE_METADATA.minimumMacOSVersion,
  "LSMinimumSystemVersion",
);
assertValue(
  info.NSMicrophoneUsageDescription,
  `${RELEASE_METADATA.productName} records audio only while you dictate and processes it locally on this Mac.`,
  "NSMicrophoneUsageDescription",
);
assertValue(
  info.NSAudioCaptureUsageDescription,
  info.NSMicrophoneUsageDescription,
  "NSAudioCaptureUsageDescription",
);

if (!existsSync(executablePath) || (statSync(executablePath).mode & 0o111) === 0) {
  fail("main executable is missing or not executable");
}
const architectures = execFileSync("lipo", ["-archs", executablePath], {
  encoding: "utf8",
}).trim().split(/\s+/u);
if (
  architectures.length !== 1 ||
  architectures[0] !== RELEASE_LAYOUT.target.arch
) {
  fail(
    `main executable architectures are [${architectures.join(", ")}], ` +
    `expected [${RELEASE_LAYOUT.target.arch}]`,
  );
}

const iconName = info.CFBundleIconFile;
if (typeof iconName !== "string" || iconName.length === 0) {
  fail("CFBundleIconFile is missing");
}
const packagedIconPath = path.join(resourcesPath, iconName);
const sourceIconPath = path.resolve(
  "resources",
  "branding",
  `${RELEASE_METADATA.productName}.icns`,
);
if (!existsSync(packagedIconPath) || sha256(packagedIconPath) !== sha256(sourceIconPath)) {
  fail(`packaged icon does not match ${sourceIconPath}`);
}

if (!existsSync(asarPath)) fail("Contents/Resources/app.asar is missing");
const embeddedAsar = info.ElectronAsarIntegrity?.["Resources/app.asar"];
if (embeddedAsar?.algorithm !== "SHA256" || typeof embeddedAsar.hash !== "string") {
  fail("Info.plist is missing ElectronAsarIntegrity for Resources/app.asar");
}
const { headerString } = getRawHeader(asarPath);
const actualHeaderHash = createHash("sha256").update(headerString).digest("hex");
assertValue(embeddedAsar.hash, actualHeaderHash, "ElectronAsarIntegrity hash");

await assertFuses(appPath);
assertCodeSignature(appPath, publicRelease);
console.log(
  `macOS bundle verified: identity, macOS ${RELEASE_METADATA.minimumMacOSVersion}+ floor, icon, ` +
    `${RELEASE_LAYOUT.target.arch} executable, ASAR integrity, Electron fuses, and code signature ` +
    `passed for ${appPath}.`,
);
