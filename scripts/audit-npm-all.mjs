#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * The advisories behind the residual, pinned exactly. An advisory whose URL,
 * package, severity, or affected range is not spelled here fails the gate.
 *
 * Reviewed 2026-08-07: both are denial-of-service parsing loops in
 * `image-size`, which `appdmg` uses to read the volume icon while building the
 * DMG. The only images it ever parses are this repository's own committed
 * icons, so reaching either loop would require an attacker who can already
 * modify the source tree. `image-size` is a build-time devDependency and is
 * absent from the packaged application, which `audit:production` proves
 * independently by staying clean. There is no patched `appdmg` release that
 * `electron-installer-dmg` accepts, so this cannot be resolved by upgrading.
 */
export const EXPECTED_BUILD_TOOL_ADVISORIES = Object.freeze({
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
});

/**
 * npm reports every affected ancestor as a vulnerability entry. Keep this
 * exact node inventory deliberately narrow: a new package, path, or advisory
 * must fail the gate and receive a fresh review.
 *
 * Re-recorded 2026-08-07. The previous inventory was the whole Forge tree
 * hanging off one `brace-expansion` advisory; upstream shipped patched
 * releases, so that residual is gone and this smaller `image-size` chain is
 * what remains. `nanoid` also appeared here and was not recorded, because a
 * compatible patched release existed and `npm update nanoid` took it.
 */
export const EXPECTED_BUILD_TOOL_VULNERABILITY_NODES = Object.freeze({
  "@electron-forge/maker-dmg": ["node_modules/@electron-forge/maker-dmg"],
  appdmg: ["node_modules/appdmg"],
  "electron-installer-dmg": ["node_modules/electron-installer-dmg"],
  "image-size": ["node_modules/image-size"],
});

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStrings(left, right) {
  return Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
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

  const expectedNames = Object.keys(EXPECTED_BUILD_TOOL_VULNERABILITY_NODES).sort();
  if (!sameStrings(vulnerabilityNames, expectedNames)) {
    throw new Error(
      "npm audit found a package outside the exact reviewed build-tool residual.",
    );
  }
  assertMetadataCounts(report, expectedNames.length);

  const seenAdvisories = new Set();
  for (const name of expectedNames) {
    const vulnerability = report.vulnerabilities[name];
    const expectedNodes = EXPECTED_BUILD_TOOL_VULNERABILITY_NODES[name];
    if (
      !isRecord(vulnerability) ||
      vulnerability.name !== name ||
      vulnerability.severity !== "high" ||
      !sameStrings(vulnerability.nodes, expectedNodes) ||
      !Array.isArray(vulnerability.via)
    ) {
      throw new Error(`npm audit entry changed for reviewed build tool ${name}.`);
    }

    for (const via of vulnerability.via) {
      if (typeof via === "string") continue;
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
      seenAdvisories.add(via.url);
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
