export const EXPECTED_BUILD_TOOL_VULNERABILITY_NODES: Readonly<
  Record<string, readonly string[]>
>;

export function evaluateFullNpmAudit(
  report: unknown,
):
  | { status: "clean" }
  | { status: "known-residual"; advisory: string };
