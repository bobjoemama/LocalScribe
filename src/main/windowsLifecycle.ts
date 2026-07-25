import path from "node:path";
import { RELEASE_POLICY } from "../shared/releasePolicy.mts";
import type { LaunchAtLoginStatus } from "../shared/contracts";

export const WINDOWS_HIDDEN_STARTUP_ARGUMENT = "--hidden";
export const WINDOWS_APP_USER_MODEL_ID =
  RELEASE_POLICY.windowsAppUserModelId;

export interface LoginItemSettings {
  openAtLogin: boolean;
  path?: string;
  args?: string[];
}

export interface LoginItemState {
  openAtLogin: boolean;
  status?:
    | "not-registered"
    | "enabled"
    | "requires-approval"
    | "not-found"
    | "unknown";
  executableWillLaunchAtLogin?: boolean;
}

/**
 * Portable Windows builds register the exact executable the user launched.
 * Passing the same path/arguments when disabling also removes that precise
 * registry entry instead of leaving an orphaned startup command.
 */
export function loginItemSettings(
  openAtLogin: boolean,
  platform: NodeJS.Platform,
  executablePath: string,
): LoginItemSettings {
  if (platform !== "win32") return { openAtLogin };
  if (
    !path.win32.isAbsolute(executablePath)
    || executablePath.includes("\0")
    || path.win32.extname(executablePath).toLowerCase() !== ".exe"
  ) {
    throw new Error("Windows login startup requires an absolute executable path.");
  }
  return {
    openAtLogin,
    path: executablePath,
    args: [WINDOWS_HIDDEN_STARTUP_ARGUMENT],
  };
}

export function loginItemQueryOptions(
  platform: NodeJS.Platform,
  executablePath: string,
): { path: string; args: string[] } | undefined {
  if (platform !== "win32") return undefined;
  const settings = loginItemSettings(true, platform, executablePath);
  return { path: settings.path!, args: settings.args! };
}

export function launchAtLoginStatusFor(
  platform: NodeJS.Platform,
  state: LoginItemState,
): LaunchAtLoginStatus {
  if (platform === "darwin") {
    const requiresApproval = state.status === "requires-approval";
    const effective = state.status === "enabled"
      || (state.status === undefined && state.openAtLogin);
    const registered = state.openAtLogin
      || effective
      || requiresApproval;
    return {
      supported: true,
      registered,
      effective,
      requiresApproval,
      status: requiresApproval
        ? "requires-approval"
        : effective
          ? "enabled"
          : registered
            ? "disabled"
            : "not-registered",
    };
  }
  if (platform === "win32") {
    const registered = state.openAtLogin;
    const effective = state.executableWillLaunchAtLogin === true;
    return {
      supported: true,
      registered,
      effective,
      requiresApproval: false,
      status: effective ? "enabled" : registered ? "disabled" : "not-registered",
    };
  }
  return {
    supported: false,
    registered: false,
    effective: false,
    requiresApproval: false,
    status: "unavailable",
  };
}

export function shouldOpenSettingsAtStartup(
  platform: NodeJS.Platform,
  arguments_: readonly string[],
  wasOpenedAtLogin: boolean,
): boolean {
  if (platform === "win32") {
    return !arguments_.includes(WINDOWS_HIDDEN_STARTUP_ARGUMENT);
  }
  return !wasOpenedAtLogin;
}
