import type { LaunchAtLoginStatus } from "../shared/contracts";

export interface LoginItemSettings {
  openAtLogin: boolean;
}

export interface LoginItemState {
  openAtLogin: boolean;
  status?:
    | "not-registered"
    | "enabled"
    | "requires-approval"
    | "not-found"
    | "unknown";
}

/** Electron maps this directly to the macOS login-item registration. */
export function loginItemSettings(openAtLogin: boolean): LoginItemSettings {
  return { openAtLogin };
}

export function launchAtLoginStatusFor(
  state: LoginItemState,
): LaunchAtLoginStatus {
  const requiresApproval = state.status === "requires-approval";
  const effective = state.status === "enabled"
    || (state.status === undefined && state.openAtLogin);
  const registered = state.openAtLogin || effective || requiresApproval;
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

export function shouldOpenSettingsAtStartup(
  wasOpenedAtLogin: boolean,
): boolean {
  return !wasOpenedAtLogin;
}
