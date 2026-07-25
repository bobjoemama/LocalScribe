import { describe, expect, it } from "vitest";
import {
  EXPECTED_BUILD_TOOL_VULNERABILITY_NODES,
  evaluateFullNpmAudit,
} from "../scripts/audit-npm-all.mjs";

const ADVISORY = {
  source: 1_124_334,
  name: "brace-expansion",
  dependency: "brace-expansion",
  title: "brace-expansion denial of service",
  url: "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
  severity: "high",
  range: "<=5.0.7",
};

function reportWithKnownResidual(): Record<string, unknown> {
  const entries = Object.entries(EXPECTED_BUILD_TOOL_VULNERABILITY_NODES);
  return {
    auditReportVersion: 2,
    vulnerabilities: Object.fromEntries(entries.map(([name, nodes]) => [
      name,
      {
        name,
        severity: "high",
        nodes: [...nodes],
        via: name === "brace-expansion" ? [ADVISORY] : ["brace-expansion"],
      },
    ])),
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: entries.length,
        critical: 0,
        total: entries.length,
      },
    },
  };
}

describe("full npm audit exact-residual gate", () => {
  it("recognizes the exact reviewed build-tool residual without calling it clean", () => {
    expect(evaluateFullNpmAudit(reportWithKnownResidual())).toEqual({
      status: "known-residual",
      advisory: "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
    });
  });

  it("rejects any additional advisory", () => {
    const report = reportWithKnownResidual() as {
      vulnerabilities: Record<string, { via: unknown[] }>;
    };
    report.vulnerabilities["brace-expansion"]!.via.push({
      ...ADVISORY,
      url: "https://github.com/advisories/GHSA-unreviewed",
    });

    expect(() => evaluateFullNpmAudit(report)).toThrow(
      "outside the exact reviewed residual",
    );
  });

  it("rejects a changed package or installation path", () => {
    const changedPackage = reportWithKnownResidual() as {
      vulnerabilities: Record<string, unknown>;
    };
    changedPackage.vulnerabilities["new-build-tool"] = {
      name: "new-build-tool",
      severity: "high",
      nodes: ["node_modules/new-build-tool"],
      via: ["brace-expansion"],
    };
    expect(() => evaluateFullNpmAudit(changedPackage)).toThrow(
      "outside the exact reviewed build-tool residual",
    );

    const changedPath = reportWithKnownResidual() as {
      vulnerabilities: Record<string, { nodes: string[] }>;
    };
    changedPath.vulnerabilities.minimatch!.nodes = ["node_modules/other/minimatch"];
    expect(() => evaluateFullNpmAudit(changedPath)).toThrow(
      "entry changed for reviewed build tool minimatch",
    );
  });

  it("rejects malformed audit JSON", () => {
    expect(() => evaluateFullNpmAudit({ auditReportVersion: 2 })).toThrow(
      "unsupported or malformed",
    );
  });

  it("accepts a structurally valid zero-advisory report as clean", () => {
    expect(evaluateFullNpmAudit({
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 0,
          critical: 0,
          total: 0,
        },
      },
    })).toEqual({ status: "clean" });
  });
});
