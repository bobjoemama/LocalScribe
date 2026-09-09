#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import {
  HELPER_ENTITLEMENT_ROLES,
  assertHelperEntitlements,
  assertMainAppEntitlements,
  assertUnprivileged,
  helperEntitlementRole,
} from "./macos-entitlement-policy.mts";
import {
  loadReleaseMetadata,
  releaseLayout,
} from "./release-metadata.mts";

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
  assertUnprivileged({ label: filePath, signedPlist: entitlements(filePath), fail });
}

const releaseLayout_ = releaseLayout(loadReleaseMetadata(), "darwin");
const appPath = path.resolve(process.argv[2] ?? releaseLayout_.applicationPath);
const resourcesPath = path.join(appPath, "Contents", "Resources");
const activeTarget = path.join(resourcesPath, "native", "macos", "active-target");
const fluidAudioHelper = path.join(
  resourcesPath,
  "native",
  "macos",
  "localscribe-fluidaudio-parakeet",
);
const runtimeRoot = path.join(resourcesPath, "python-runtime");
const appEntitlements = entitlements(appPath);

/*
 * The declared plist is the allowlist. A presence check cannot reject an
 * addition, so the signature is compared with `resources/entitlements.mac.plist`
 * as an exact set, and hardened-runtime escapes are named explicitly.
 */
const signedEntitlements = assertMainAppEntitlements({
  declaredPlist: readFileSync(path.resolve("resources/entitlements.mac.plist"), "utf8"),
  signedPlist: appEntitlements,
  fail,
});

assertNoEntitlementKeys(activeTarget);
assertNoEntitlementKeys(fluidAudioHelper);
assertNoEntitlementKeys(path.join(resourcesPath, "native", "macos", "liblocalscribe-canary.dylib"));
const runtimeMachOFiles = collectMachOFiles(runtimeRoot);
if (runtimeMachOFiles.length === 0) fail("the packaged Python runtime contains no Mach-O files");
for (const binary of runtimeMachOFiles) assertNoEntitlementKeys(binary);

/*
 * Contents/Frameworks, which this gate did not look at until now.
 *
 * All four Electron helper apps live here, each signed with its own plist by
 * `signingEntitlementsFor` in forge.config.ts, and none of them was verified by
 * anything: not this script, not verify-macos-bundle.mjs (outer app only), not
 * package-provenance.mts (hashes the plists, so it records a change rather than
 * rejecting one), and not the unit suite, which screened the helper plists for
 * "camera"/"bluetooth"/"usb"/"print"/"location" and no hardened-runtime escape
 * at all. A renderer helper signed `get-task-allow` — letting any process the
 * user runs attach and read decrypted transcripts out of its memory — shipped,
 * notarized, and printed "macOS entitlements verified".
 */
const frameworksPath = path.join(appPath, "Contents", "Frameworks");
const nestedBundles = readdirSync(frameworksPath)
  .filter((entry) => entry.endsWith(".app"))
  .sort()
  .map((entry) => path.join(frameworksPath, entry));

if (nestedBundles.length === 0) fail("Contents/Frameworks contains no helper applications");

const verifiedHelpers = [];
let nestedHelperMachOCount = 0;
for (const bundle of nestedBundles) {
  const role = helperEntitlementRole(bundle);
  // An unrecognised nested application is a rejection, not something to skip:
  // "we did not know how to check it" must never read as "it is fine".
  if (!role) fail(`${path.basename(bundle)} is not a known helper and has no entitlement policy`);
  const declaredPlistPath = HELPER_ENTITLEMENT_ROLES[role].declaredPlistPath;
  const executableName = execFileSync(
    "plutil",
    ["-extract", "CFBundleExecutable", "raw", "-o", "-", path.join(bundle, "Contents", "Info.plist")],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  if (!executableName || executableName.includes("/") || executableName.includes("\\")) {
    fail(`${path.basename(bundle)} has an invalid CFBundleExecutable`);
  }
  const executable = path.join(bundle, "Contents", "MacOS", executableName);
  const nestedMachOFiles = collectMachOFiles(bundle);
  if (!nestedMachOFiles.includes(executable)) {
    fail(`${path.basename(bundle)} executable is not a nested Mach-O file`);
  }
  const keys = assertHelperEntitlements({
    role,
    label: path.basename(bundle),
    declaredPlist: readFileSync(path.resolve(declaredPlistPath), "utf8"),
    signedPlist: entitlements(executable),
    fail,
  });
  for (const binary of nestedMachOFiles) {
    if (binary !== executable) assertNoEntitlementKeys(binary);
  }
  nestedHelperMachOCount += nestedMachOFiles.length;
  verifiedHelpers.push(`${path.basename(bundle, ".app")} [${role}]: ${keys.join(", ") || "none"}`);
}

/*
 * Everything else under Frameworks is library code — the Electron framework
 * itself, Squirrel, Mantle, ReactiveObjC. None of it is a signing target with
 * entitlements, so any entitlement here means something was signed that should
 * not have been.
 */
const frameworkMachOFiles = collectMachOFiles(frameworksPath)
  .filter((file) => !nestedBundles.some((bundle) => file.startsWith(`${bundle}${path.sep}`)));
if (frameworkMachOFiles.length === 0) fail("Contents/Frameworks contains no framework Mach-O files");
for (const binary of frameworkMachOFiles) assertNoEntitlementKeys(binary);

console.log(
  `macOS entitlements verified: main app carries exactly ${signedEntitlements.join(", ")};`
  + ` ${verifiedHelpers.length} helper bundles match their declared plists`
  + ` (${verifiedHelpers.join("; ")});`
  + ` active-target, FluidAudio helper, ${runtimeMachOFiles.length} runtime, ${nestedHelperMachOCount}`
  + ` nested-helper and ${frameworkMachOFiles.length}`
  + " framework Mach-O files are unprivileged.",
);
