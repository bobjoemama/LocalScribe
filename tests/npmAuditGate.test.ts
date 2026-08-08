import { describe, expect, it } from "vitest";
import {
  EXPECTED_BUILD_TOOL_ADVISORIES,
  EXPECTED_BUILD_TOOL_VULNERABILITY_NODES,
  evaluateFullNpmAudit,
} from "../scripts/audit-npm-all.mjs";

/*
 * Every reviewed advisory is an `image-size` advisory, and npm attaches the
 * advisory objects to the package they are about; the ancestors that merely
 * inherit the vulnerability carry a string reference instead. Building the
 * synthetic report from the exported inventories rather than a hand-copied
 * literal means a future re-review that edits the inventory cannot leave this
 * test asserting against a residual that no longer exists.
 */
const ADVISORY_HOST = "image-size";
const ADVISORY_URLS: readonly string[] = Object.keys(EXPECTED_BUILD_TOOL_ADVISORIES).sort();

function advisoryObjects(): Record<string, unknown>[] {
  return ADVISORY_URLS.map((url, index) => {
    const reviewed = EXPECTED_BUILD_TOOL_ADVISORIES[url];
    if (!reviewed) throw new Error(`no reviewed advisory recorded for ${url}`);
    return {
      source: 1_000_000 + index,
      ...reviewed,
      title: `reviewed advisory ${index}`,
      url,
    };
  });
}

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
        via: name === ADVISORY_HOST ? advisoryObjects() : [ADVISORY_HOST],
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
  /*
   * Without this, every assertion below would still pass against an empty
   * inventory — `sameStrings([], [])` is true and the loop would not run.
   */
  it("has a nonempty reviewed residual to check", () => {
    expect(ADVISORY_URLS.length).toBeGreaterThan(0);
    expect(Object.keys(EXPECTED_BUILD_TOOL_VULNERABILITY_NODES)).toContain(ADVISORY_HOST);
  });

  it("recognizes the exact reviewed build-tool residual without calling it clean", () => {
    expect(evaluateFullNpmAudit(reportWithKnownResidual())).toEqual({
      status: "known-residual",
      advisories: ADVISORY_URLS,
    });
  });

  it("rejects any additional advisory", () => {
    const report = reportWithKnownResidual() as {
      vulnerabilities: Record<string, { via: unknown[] }>;
    };
    report.vulnerabilities[ADVISORY_HOST]!.via.push({
      ...advisoryObjects()[0],
      url: "https://github.com/advisories/GHSA-unreviewed",
    });

    expect(() => evaluateFullNpmAudit(report)).toThrow(
      "outside the exact reviewed residual",
    );
  });

  /*
   * The count-versus-set distinction: this report has as many advisory objects
   * as the reviewed residual, and every one of them is individually reviewed,
   * but it is not the reviewed set.
   */
  it("rejects one reviewed advisory duplicated in place of another", () => {
    if (ADVISORY_URLS.length < 2) return;
    const report = reportWithKnownResidual() as {
      vulnerabilities: Record<string, { via: Record<string, unknown>[] }>;
    };
    const via = report.vulnerabilities[ADVISORY_HOST]!.via;
    via[via.length - 1] = { ...via[0]! };

    expect(() => evaluateFullNpmAudit(report)).toThrow(
      "did not contain exactly the reviewed advisories",
    );
  });

  /*
   * A URL must be matched as an own property. Naming something like
   * `constructor` is not enough to show that, because whatever inheritance
   * returns then fails the field comparison a line later for unrelated
   * reasons — the assertion would hold with or without the guard. The only
   * report that separates the two is one whose inherited value is a complete,
   * correctly shaped advisory, so this plants exactly that on
   * `Object.prototype` and takes it away again.
   */
  it("rejects an advisory whose url names an inherited property", () => {
    const INHERITED_URL = "localscribe-inherited-advisory-probe";
    Object.defineProperty(Object.prototype, INHERITED_URL, {
      configurable: true,
      enumerable: false, // an enumerable addition would leak into unrelated iteration
      value: {
        name: ADVISORY_HOST,
        dependency: ADVISORY_HOST,
        severity: "high",
        range: "<=2.0.2",
      },
    });
    try {
      const report = reportWithKnownResidual() as {
        vulnerabilities: Record<string, { via: Record<string, unknown>[] }>;
      };
      report.vulnerabilities[ADVISORY_HOST]!.via = [
        { ...advisoryObjects()[0], url: INHERITED_URL },
      ];

      expect(() => evaluateFullNpmAudit(report)).toThrow(
        "outside the exact reviewed residual",
      );
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>)[INHERITED_URL];
    }
    expect(INHERITED_URL in {}).toBe(false);
  });

  it("rejects a changed package or installation path", () => {
    const changedPackage = reportWithKnownResidual() as {
      vulnerabilities: Record<string, unknown>;
    };
    changedPackage.vulnerabilities["new-build-tool"] = {
      name: "new-build-tool",
      severity: "high",
      nodes: ["node_modules/new-build-tool"],
      via: [ADVISORY_HOST],
    };
    expect(() => evaluateFullNpmAudit(changedPackage)).toThrow(
      "outside the exact reviewed build-tool residual",
    );

    const changedPath = reportWithKnownResidual() as {
      vulnerabilities: Record<string, { nodes: string[] }>;
    };
    changedPath.vulnerabilities[ADVISORY_HOST]!.nodes = ["node_modules/other/image-size"];
    expect(() => evaluateFullNpmAudit(changedPath)).toThrow(
      `entry changed for reviewed build tool ${ADVISORY_HOST}`,
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
