import { existsSync } from "node:fs";
import path from "node:path";

export const NATIVE_ACTIVE_TARGET_HELPER_OVERRIDE = "LOCALSCRIBE_NATIVE_INSERTION_HELPER";

export interface NativeActiveTargetHelperPathOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  /** Must be explicitly enabled by a development or test caller. */
  allowEnvironmentOverride?: boolean;
  resourcesPath?: string;
  workingDirectory?: string;
  exists?: (candidate: string) => boolean;
}

/**
 * Resolves the single native helper shared by insertion and the macOS
 * permission-free Control monitor. Packaged resources win over a source-tree
 * binary so an app bundle never accidentally executes a development helper.
 */
export function resolveNativeActiveTargetHelperPath(
  options: NativeActiveTargetHelperPathOptions = {},
): string | null {
  const environment = options.environment ?? process.env;
  const override = environment[NATIVE_ACTIVE_TARGET_HELPER_OVERRIDE];
  if (override && options.allowEnvironmentOverride === true) return path.resolve(override);

  const platform = options.platform ?? process.platform;
  const relativePath = platform === "darwin"
    ? ["native", "macos", "active-target"]
    : platform === "win32"
      ? ["native", "windows", "active-target.exe"]
      : null;
  if (!relativePath) return null;

  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const exists = options.exists ?? existsSync;
  const packagedPath = path.join(resourcesPath, ...relativePath);
  if (exists(packagedPath)) return packagedPath;

  const developmentPath = path.resolve(workingDirectory, "resources", ...relativePath);
  if (exists(developmentPath)) return developmentPath;

  // Preserve the old caller contract: the executable bridge itself converts a
  // missing helper into an unavailable capability without throwing at startup.
  return packagedPath;
}
