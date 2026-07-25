import { RELEASE_POLICY } from "../src/shared/releasePolicy.mts";

export interface MakeResultLike {
  platform: string;
  arch: string;
  artifacts: readonly string[];
}

/**
 * Forge has historically allowed a maker subprocess to log a failure and
 * still return success. An empty result list or an empty artifact list must
 * therefore fail before any platform-specific verifier is considered.
 */
export function assertExpectedMakeResults(
  makeResults: readonly MakeResultLike[],
  hostPlatform: NodeJS.Platform,
): void {
  const expectedPlatform = hostPlatform === "darwin"
    ? "darwin"
    : hostPlatform === "win32"
      ? "win32"
      : null;
  const expectedArch = expectedPlatform
    ? RELEASE_POLICY.targets[expectedPlatform].arch
    : null;
  if (!expectedPlatform) {
    throw new Error(`LocalScribe make verification is unsupported on ${hostPlatform}.`);
  }
  if (makeResults.length === 0) {
    throw new Error(
      `${expectedPlatform}/${expectedArch} make returned no results or artifacts.`,
    );
  }
  const wrongTargets = makeResults.filter(
    (result) =>
      result.platform !== expectedPlatform ||
      result.arch !== expectedArch,
  );
  if (wrongTargets.length > 0) {
    throw new Error(
      `Make returned an unexpected target: ` +
      wrongTargets.map((result) => `${result.platform}/${result.arch}`).join(", "),
    );
  }
  const emptyResults = makeResults.filter((result) => result.artifacts.length === 0);
  if (emptyResults.length > 0) {
    throw new Error(
      `${expectedPlatform}/${expectedArch} maker returned an empty artifact list.`,
    );
  }
}
