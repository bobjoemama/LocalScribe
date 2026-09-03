/**
 * The platform-independent gate suite run by `npm run ci`, in execution order.
 * Each entry is the argument list handed to npm, e.g. `["run", "lint:all"]`.
 */
export const SOURCE_VERIFICATION_CHECKS: readonly (readonly string[])[];
export const RELEASE_CANDIDATE_ARGUMENT: "--release-candidate";

export function releaseCandidateModeFromArguments(arguments_: readonly string[]): boolean;
export function assertReleaseCandidateGitState(
  projectPath?: string,
  inputCandidates?: readonly string[],
): void;
