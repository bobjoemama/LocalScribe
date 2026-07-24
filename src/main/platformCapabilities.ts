import type {
  PermissionSnapshot,
  RuntimePlatform,
} from "../shared/contracts";

export type PermissionKind = "microphone" | "accessibility";

/**
 * Collapse Node's platform string into the small set LocalScribe actually
 * supports.  The renderer receives this explicit value rather than trying to
 * infer OS support from a browser user agent.
 */
export function runtimePlatformFor(platform: string): RuntimePlatform {
  if (platform === "darwin" || platform === "win32" || platform === "linux") return platform;
  return "unsupported";
}

/**
 * macOS is the only currently supported platform with a separately granted
 * Accessibility permission.  Windows has no equivalent privacy toggle for
 * this app; Linux is deliberately reported as unsupported instead of claiming
 * that a synthetic input path will work.
 */
export function permissionSnapshotForPlatform(
  platform: RuntimePlatform,
  microphone: PermissionSnapshot["microphone"],
  accessibilityGranted: boolean,
  globalHoldReady: boolean,
): PermissionSnapshot {
  const isMac = platform === "darwin";
  const isWindows = platform === "win32";
  return {
    platform,
    microphone,
    microphoneSettingsAvailable: isMac || isWindows,
    accessibility: {
      supported: isMac,
      granted: isMac && accessibilityGranted,
    },
    automaticPaste: {
      supported: isMac || isWindows,
      ready: isMac ? accessibilityGranted : isWindows,
    },
    globalHold: {
      supported: isMac || isWindows,
      // Accessibility permits the full macOS hook, but only HotkeyService can
      // prove that either that hook or the bare-Control fallback actually
      // started. Keep capability support separate from runtime readiness.
      ready: (isMac || isWindows) && globalHoldReady,
    },
  };
}

/** Returns a real settings deep-link only where the operating system supports one. */
export function permissionSettingsUrl(
  platform: RuntimePlatform,
  permission: PermissionKind,
): string | null {
  if (platform === "darwin") {
    return permission === "microphone"
      ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
      : "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
  }
  if (platform === "win32" && permission === "microphone") return "ms-settings:privacy-microphone";
  return null;
}
