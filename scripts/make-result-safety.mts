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
  if (hostPlatform !== "darwin") {
    throw new Error(`LocalScribe make verification is unsupported on ${hostPlatform}.`);
  }
  const expectedPlatform = "darwin";
  const expectedArch = RELEASE_POLICY.targets.darwin.arch;
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
