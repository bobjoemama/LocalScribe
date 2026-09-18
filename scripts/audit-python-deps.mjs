#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const auditToolProject = "tools/python-audit";
const projects = [
  { label: "macOS worker", directory: "worker" },
  { label: "Python audit tooling", directory: auditToolProject },
];

function run(command, args, captureStdout = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: captureStdout ? ["ignore", "pipe", "inherit"] : "inherit",
  });

  if (result.error) {
    throw new Error(`Unable to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}.`);
  }
  return result.stdout ?? "";
}

function exportAuditRequirements(project) {
  const exported = run(
    "uv",
    [
      "export",
      "--project",
      project.directory,
      "--locked",
      "--no-dev",
      "--no-emit-project",
      "--format",
      "requirements.txt",
      "--no-annotate",
      "--no-header",
    ],
    true,
  );

  // Audit every exact package/version present in the lock, including inactive
  // environment-marker branches. pip-audit otherwise skips them on this host.
  const requirements = [];
  let pinCount = 0;
  for (const rawLine of exported.split(/\r?\n/u)) {
    if (!rawLine.trim()) continue;
    if (/^\s/u.test(rawLine)) {
      requirements.push(rawLine);
      continue;
    }

    const markerIndex = rawLine.indexOf(" ; ");
    const continuation = rawLine.endsWith(" \\") ? " \\" : "";
    const auditLine = markerIndex >= 0
      ? `${rawLine.slice(0, markerIndex)}${continuation}`
      : rawLine;
    const exactPin = auditLine.replace(/\s+\\$/u, "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9._,-]+\])?==[^\s;]+$/u.test(exactPin)) {
      throw new Error(
        `${project.label} export contained a non-exact requirement: ${JSON.stringify(rawLine)}`,
      );
    }
    requirements.push(auditLine);
    pinCount += 1;
  }

  if (pinCount === 0) {
    throw new Error(`${project.label} export did not contain any auditable dependencies.`);
  }
  return {
    contents: `${requirements.join("\n")}\n`,
    pinCount,
  };
}

const auditDirectory = mkdtempSync(join(tmpdir(), "localscribe-python-audit-"));

try {
  run("uv", [
    "run", "--project", auditToolProject, "--locked", "python", "-B",
    "scripts/test-pip-url-boundary.py",
  ]);
  for (const project of projects) {
    const auditRequirements = exportAuditRequirements(project);
    const requirementsPath = join(
      auditDirectory,
      `${project.label.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-")}.txt`,
    );
    writeFileSync(requirementsPath, auditRequirements.contents, "utf8");

    console.log(
      `Auditing ${project.label}: ${auditRequirements.pinCount} exact packages from ${project.directory}/uv.lock`,
    );
    run("uv", [
      "run",
      "--project",
      auditToolProject,
      "--locked",
      "python",
      "-m",
      "pip_audit",
      "--requirement",
      requirementsPath,
      "--disable-pip",
      "--require-hashes",
      "--strict",
      "--progress-spinner",
      "off",
      "--cache-dir",
      join(auditDirectory, "cache"),
    ]);
  }
} finally {
  rmSync(auditDirectory, { force: true, recursive: true });
}
