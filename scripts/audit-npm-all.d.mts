export interface ReviewedAdvisory {
  readonly name: string;
  readonly dependency: string;
  readonly severity: string;
  readonly range: string;
}

/** Keyed by advisory URL. */
export const EXPECTED_BUILD_TOOL_ADVISORIES: Readonly<
  Record<string, ReviewedAdvisory>
>;

export const EXPECTED_BUILD_TOOL_VULNERABILITY_NODES: Readonly<
  Record<string, readonly string[]>
>;

export interface ReviewedVulnerability {
  readonly nodes: readonly string[];
  readonly via: readonly string[];
}

/** Keyed by vulnerable package name; both node and ancestry sets are exact. */
export const EXPECTED_BUILD_TOOL_VULNERABILITIES: Readonly<
  Record<string, ReviewedVulnerability>
>;

export function evaluateFullNpmAudit(
  report: unknown,
):
  | { status: "clean" }
  | { status: "known-residual"; advisories: readonly string[] };
