#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * The advisories behind the residual, pinned exactly. An advisory whose URL,
 * package, severity, or affected range is not spelled here fails the gate.
 *
 * Re-reviewed 2026-09-18:
 *
 * - `image-size` is called by `appdmg` to read the DMG background dimensions.
 *   This configuration uses electron-installer-dmg's bundled background.png;
 *   it does not accept a user-supplied background. This is a build-only path,
 *   absent from the packaged application. image-size 2.0.4 is patched, but
 *   appdmg 0.6.6 requires the incompatible 0.7.x path/callback API, so a
 *   forced major-version override is not a supported fix.
 * - `extract-zip` remains a transitive dependency of the pinned Electron
 *   packager. Its advisory is a symlink traversal during extraction. Our
 *   artifact verifier never calls it. `macos-zip-preflight.mts` validates
 *   canonical paths, Unix modes, collisions, special files, expansion limits,
 *   and every bundle-relative symlink target before macOS `ditto` extracts the
 *   archive while preserving signed `.app` semantics. The remaining transitive
 *   copy is build-only. Stable Forge 7 still requires packager 18, which uses
 *   extract-zip 2.0.1. Newer packager 20 uses Electron's maintained fork, but
 *   overriding Forge's major-version contract or aliasing its extractor needs
 *   separate compatibility and package verification, not an audit waiver.
 *
 * This narrowly accepts the current build-tool graph only. It is not a waiver
 * for archive extraction in runtime code, arbitrary archives, or new
 * ancestors introduced by a dependency update.
 */
export const EXPECTED_BUILD_TOOL_ADVISORIES = Object.freeze({
  // Re-reviewed 2026-09-09: final-component symlink overwrite, still in the
  // same build-only extract-zip@2.0.1 path. No patched release exists. Product
  // archive verification uses preflight + ditto, not this dependency; preflight
  // rejects duplicate names before extraction (covered by a real ZIP fixture).
  "https://github.com/advisories/GHSA-7pqw-9j4j-h8q3": Object.freeze({
    name: "extract-zip",
    dependency: "extract-zip",
    severity: "high",
    range: "<=2.0.1",
  }),
  "https://github.com/advisories/GHSA-w3rx-r6r6-pgpr": Object.freeze({
    name: "image-size",
    dependency: "image-size",
    severity: "high",
    range: "<=2.0.2",
  }),
  "https://github.com/advisories/GHSA-5p2g-fcmc-qvqq": Object.freeze({
    name: "image-size",
    dependency: "image-size",
    severity: "high",
    range: "<=2.0.2",
  }),
  "https://github.com/advisories/GHSA-jmr9-qjv8-65gv": Object.freeze({
    name: "extract-zip",
    dependency: "extract-zip",
    severity: "high",
    range: "<=2.0.1",
  }),
});

/**
 * npm reports every affected ancestor as a vulnerability entry. Keep this
 * exact node inventory deliberately narrow: a new package, path, or advisory
 * must fail the gate and receive a fresh review.
 *
 * Re-recorded 2026-08-15. `extract-zip` appears through the pinned Electron
 * packager, so npm reports the exact Forge ancestors below as affected too.
 * Each ancestor has its exact `via` set recorded; accepting only the terminal
 * packages would let a new affected Forge path pass review unnoticed.
 */
export const EXPECTED_BUILD_TOOL_VULNERABILITIES = Object.freeze({
  "@electron-forge/cli": Object.freeze({
    nodes: Object.freeze(["node_modules/@electron-forge/cli"]),
    via: Object.freeze(["@electron-forge/core", "@electron-forge/core-utils", "@electron-forge/shared-types"]),
  }),
  "@electron-forge/core": Object.freeze({
    nodes: Object.freeze(["node_modules/@electron-forge/core"]),
    via: Object.freeze(["@electron-forge/core-utils", "@electron-forge/maker-base", "@electron-forge/plugin-base", "@electron-forge/publisher-base", "@electron-forge/shared-types", "@electron-forge/template-base", "@electron-forge/template-vite", "@electron-forge/template-vite-typescript", "@electron-forge/template-webpack", "@electron-forge/template-webpack-typescript", "@electron/packager"]),
  }),
  "@electron-forge/core-utils": Object.freeze({ nodes: Object.freeze(["node_modules/@electron-forge/core-utils"]), via: Object.freeze(["@electron-forge/shared-types"]) }),
  "@electron-forge/maker-base": Object.freeze({ nodes: Object.freeze(["node_modules/@electron-forge/maker-base"]), via: Object.freeze(["@electron-forge/shared-types"]) }),
  "@electron-forge/maker-dmg": Object.freeze({ nodes: Object.freeze(["node_modules/@electron-forge/maker-dmg"]), via: Object.freeze(["@electron-forge/maker-base", "@electron-forge/shared-types", "electron-installer-dmg"]) }),
  "@electron-forge/maker-zip": Object.freeze({ nodes: Object.freeze(["node_modules/@electron-forge/maker-zip"]), via: Object.freeze(["@electron-forge/maker-base", "@electron-forge/shared-types"]) }),
  "@electron-forge/plugin-auto-unpack-natives": Object.freeze({ nodes: Object.freeze(["node_modules/@electron-forge/plugin-auto-unpack-natives"]), via: Object.freeze(["@electron-forge/plugin-base", "@electron-forge/shared-types"]) }),
  "@electron-forge/plugin-base": Object.freeze({ nodes: Object.freeze(["node_modules/@electron-forge/plugin-base"]), via: Object.freeze(["@electron-forge/shared-types"]) }),
  "@electron-forge/plugin-fuses": Object.freeze({ nodes: Object.freeze(["node_modules/@electron-forge/plugin-fuses"]), via: Object.freeze(["@electron-forge/plugin-base", "@electron-forge/shared-types"]) }),
  "@electron-forge/plugin-vite": Object.freeze({ nodes: Object.freeze(["node_modules/@electron-forge/plugin-vite"]), via: Object.freeze(["@electron-forge/plugin-base", "@electron-forge/shared-types"]) }),
  "@electron-forge/publisher-base": Object.freeze({ nodes: Object.freeze(["node_modules/@electron-forge/publisher-base"]), via: Object.freeze(["@electron-forge/shared-types"]) }),
  "@electron-forge/shared-types": Object.freeze({ nodes: Object.freeze(["node_modules/@electron-forge/shared-types"]), via: Object.freeze(["@electron/packager"]) }),
  "@electron-forge/template-base": Object.freeze({ nodes: Object.freeze(["node_modules/@electron-forge/template-base"]), via: Object.freeze(["@electron-forge/core-utils", "@electron-forge/shared-types"]) }),
  "@electron-forge/template-vite": Object.freeze({ nodes: Object.freeze(["node_modules/@electron-forge/template-vite"]), via: Object.freeze(["@electron-forge/shared-types", "@electron-forge/template-base"]) }),
  "@electron-forge/template-vite-typescript": Object.freeze({ nodes: Object.freeze(["node_modules/@electron-forge/template-vite-typescript"]), via: Object.freeze(["@electron-forge/shared-types", "@electron-forge/template-base"]) }),
  "@electron-forge/template-webpack": Object.freeze({ nodes: Object.freeze(["node_modules/@electron-forge/template-webpack"]), via: Object.freeze(["@electron-forge/shared-types", "@electron-forge/template-base"]) }),
  "@electron-forge/template-webpack-typescript": Object.freeze({ nodes: Object.freeze(["node_modules/@electron-forge/template-webpack-typescript"]), via: Object.freeze(["@electron-forge/shared-types", "@electron-forge/template-base"]) }),
  "@electron/packager": Object.freeze({ nodes: Object.freeze(["node_modules/@electron/packager"]), via: Object.freeze(["extract-zip"]) }),
  appdmg: Object.freeze({ nodes: Object.freeze(["node_modules/appdmg"]), via: Object.freeze(["image-size"]) }),
  "electron-installer-dmg": Object.freeze({ nodes: Object.freeze(["node_modules/electron-installer-dmg"]), via: Object.freeze(["appdmg"]) }),
  "extract-zip": Object.freeze({ nodes: Object.freeze(["node_modules/extract-zip"]), via: Object.freeze(["https://github.com/advisories/GHSA-jmr9-qjv8-65gv", "https://github.com/advisories/GHSA-7pqw-9j4j-h8q3"]) }),
  "image-size": Object.freeze({ nodes: Object.freeze(["node_modules/image-size"]), via: Object.freeze(["https://github.com/advisories/GHSA-w3rx-r6r6-pgpr", "https://github.com/advisories/GHSA-5p2g-fcmc-qvqq"]) }),
});

export const EXPECTED_BUILD_TOOL_VULNERABILITY_NODES = Object.freeze(
  Object.fromEntries(
    Object.entries(EXPECTED_BUILD_TOOL_VULNERABILITIES).map(([name, entry]) => [name, entry.nodes]),
  ),
);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStrings(left, right) {
  return Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function sameStringSet(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    sameStrings([...left].sort(), [...right].sort())
  );
}

function assertMetadataCounts(report, expectedHigh) {
  const counts = report.metadata?.vulnerabilities;
  if (
    !isRecord(counts) ||
    counts.info !== 0 ||
    counts.low !== 0 ||
    counts.moderate !== 0 ||
    counts.high !== expectedHigh ||
    counts.critical !== 0 ||
    counts.total !== expectedHigh
  ) {
    throw new Error("npm audit vulnerability counts do not match the reviewed result.");
  }
}

export function evaluateFullNpmAudit(report) {
  if (
    !isRecord(report) ||
    report.auditReportVersion !== 2 ||
    !isRecord(report.vulnerabilities) ||
    !isRecord(report.metadata)
  ) {
    throw new Error("npm audit returned an unsupported or malformed JSON report.");
  }

  const vulnerabilityNames = Object.keys(report.vulnerabilities).sort();
  if (vulnerabilityNames.length === 0) {
    assertMetadataCounts(report, 0);
    return { status: "clean" };
  }

  const expectedNames = Object.keys(EXPECTED_BUILD_TOOL_VULNERABILITIES).sort();
  if (!sameStrings(vulnerabilityNames, expectedNames)) {
    throw new Error(
      "npm audit found a package outside the exact reviewed build-tool residual.",
    );
  }
  assertMetadataCounts(report, expectedNames.length);

  const seenAdvisories = new Set();
  for (const name of expectedNames) {
    const vulnerability = report.vulnerabilities[name];
    const expected = EXPECTED_BUILD_TOOL_VULNERABILITIES[name];
    if (
      !isRecord(vulnerability) ||
      vulnerability.name !== name ||
      vulnerability.severity !== "high" ||
      !sameStrings(vulnerability.nodes, expected.nodes) ||
      !Array.isArray(vulnerability.via)
    ) {
      throw new Error(`npm audit entry changed for reviewed build tool ${name}.`);
    }

    const actualVia = [];
    for (const via of vulnerability.via) {
      if (typeof via === "string") {
        actualVia.push(via);
        continue;
      }
      /*
       * `Object.hasOwn` rather than a bare lookup: a report naming
       * `constructor` or `__proto__` would otherwise resolve to an inherited
       * value and could satisfy the comparison below by accident.
       */
      const reviewed =
        isRecord(via) &&
        typeof via.url === "string" &&
        Object.hasOwn(EXPECTED_BUILD_TOOL_ADVISORIES, via.url)
          ? EXPECTED_BUILD_TOOL_ADVISORIES[via.url]
          : undefined;
      if (
        !reviewed ||
        via.name !== reviewed.name ||
        via.dependency !== reviewed.dependency ||
        via.severity !== reviewed.severity ||
        via.range !== reviewed.range
      ) {
        throw new Error("npm audit found an advisory outside the exact reviewed residual.");
      }
      if (via.name !== name || via.dependency !== name) {
        throw new Error("npm audit attached a reviewed advisory to an unexpected package.");
      }
      seenAdvisories.add(via.url);
      actualVia.push(via.url);
    }
    if (!sameStringSet(actualVia, expected.via)) {
      throw new Error(`npm audit dependency path changed for reviewed build tool ${name}.`);
    }
  }
  /*
   * An exact set, not a count. A report that repeated one reviewed advisory
   * twice while dropping the other would keep the count right and still be a
   * different residual than the one that was reviewed.
   */
  const expectedAdvisories = Object.keys(EXPECTED_BUILD_TOOL_ADVISORIES).sort();
  if (!sameStrings([...seenAdvisories].sort(), expectedAdvisories)) {
    throw new Error("npm audit did not contain exactly the reviewed advisories.");
  }

  return {
    status: "known-residual",
    advisories: expectedAdvisories,
  };
}

function runAudit() {
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath || !path.isAbsolute(npmExecPath)) {
    throw new Error("Full npm audit must run through the pinned npm script.");
  }
  const result = spawnSync(
    process.execPath,
    [npmExecPath, "audit", "--json", "--audit-level=high"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  if (result.error) throw result.error;

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("npm audit did not return valid JSON.", { cause: error });
  }
  const evaluation = evaluateFullNpmAudit(report);
  if (evaluation.status === "clean") {
    if (result.status !== 0) {
      throw new Error(`npm audit exited ${result.status} despite reporting no vulnerabilities.`);
    }
    console.log("Full npm audit is clean.");
    return;
  }
  if (result.status !== 1) {
    throw new Error(
      `npm audit reported the reviewed vulnerability with unexpected exit status ${result.status}.`,
    );
  }
  console.warn(
    `KNOWN UNPATCHED BUILD-TOOL RESIDUAL: ${evaluation.advisories.join(", ")}. ` +
      "The independent production audit must remain clean. Full npm audit is not clean; " +
      "the current upstream Forge dependency graph has no compatible patched release.",
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) runAudit();
