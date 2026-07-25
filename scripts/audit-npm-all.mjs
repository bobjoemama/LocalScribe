#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const KNOWN_ADVISORY_URL =
  "https://github.com/advisories/GHSA-mh99-v99m-4gvg";

/**
 * npm reports every affected ancestor as a vulnerability entry. Keep this
 * exact node inventory deliberately narrow: a new package, path, or advisory
 * must fail the gate and receive a fresh review.
 */
export const EXPECTED_BUILD_TOOL_VULNERABILITY_NODES = Object.freeze({
  "@electron-forge/cli": ["node_modules/@electron-forge/cli"],
  "@electron-forge/core": ["node_modules/@electron-forge/core"],
  "@electron-forge/core-utils": ["node_modules/@electron-forge/core-utils"],
  "@electron-forge/maker-base": ["node_modules/@electron-forge/maker-base"],
  "@electron-forge/maker-dmg": ["node_modules/@electron-forge/maker-dmg"],
  "@electron-forge/maker-squirrel": ["node_modules/@electron-forge/maker-squirrel"],
  "@electron-forge/maker-zip": ["node_modules/@electron-forge/maker-zip"],
  "@electron-forge/plugin-auto-unpack-natives": [
    "node_modules/@electron-forge/plugin-auto-unpack-natives",
  ],
  "@electron-forge/plugin-base": ["node_modules/@electron-forge/plugin-base"],
  "@electron-forge/plugin-fuses": ["node_modules/@electron-forge/plugin-fuses"],
  "@electron-forge/plugin-vite": ["node_modules/@electron-forge/plugin-vite"],
  "@electron-forge/publisher-base": ["node_modules/@electron-forge/publisher-base"],
  "@electron-forge/shared-types": ["node_modules/@electron-forge/shared-types"],
  "@electron-forge/template-base": ["node_modules/@electron-forge/template-base"],
  "@electron-forge/template-vite": ["node_modules/@electron-forge/template-vite"],
  "@electron-forge/template-vite-typescript": [
    "node_modules/@electron-forge/template-vite-typescript",
  ],
  "@electron-forge/template-webpack": [
    "node_modules/@electron-forge/template-webpack",
  ],
  "@electron-forge/template-webpack-typescript": [
    "node_modules/@electron-forge/template-webpack-typescript",
  ],
  "@electron/asar": ["node_modules/@electron/asar"],
  "@electron/packager": ["node_modules/@electron/packager"],
  "@electron/universal": ["node_modules/@electron/universal"],
  "brace-expansion": [
    "node_modules/@electron/universal/node_modules/brace-expansion",
    "node_modules/brace-expansion",
  ],
  "dir-compare": ["node_modules/dir-compare"],
  "electron-winstaller": ["node_modules/electron-winstaller"],
  glob: ["node_modules/glob"],
  minimatch: [
    "node_modules/@electron/universal/node_modules/minimatch",
    "node_modules/minimatch",
  ],
  rimraf: ["node_modules/temp/node_modules/rimraf"],
  temp: ["node_modules/temp"],
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

  let advisoryCount = 0;
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
      if (
        !isRecord(via) ||
        via.name !== "brace-expansion" ||
        via.dependency !== "brace-expansion" ||
        via.url !== KNOWN_ADVISORY_URL ||
        via.severity !== "high" ||
        via.range !== "<=5.0.7"
      ) {
        throw new Error("npm audit found an advisory outside the exact reviewed residual.");
      }
      advisoryCount += 1;
    }
  }
  if (advisoryCount !== 1) {
    throw new Error("npm audit did not contain exactly one reviewed advisory.");
  }

  return {
    status: "known-residual",
    advisory: KNOWN_ADVISORY_URL,
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
    `KNOWN UNPATCHED BUILD-TOOL RESIDUAL: ${evaluation.advisory}. ` +
      "The independent production audit must remain clean. Full npm audit is not clean; " +
      "the current upstream Forge dependency graph has no compatible patched release.",
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) runAudit();
