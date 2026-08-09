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
  automaticPasteReady: boolean,
  /*
   * Defaults to true only so existing callers keep compiling; every real
   * caller passes the live value. A default of `false` would be worse: it
   * would make the app report a working toggle as broken.
   */
  globalToggleReady = true,
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
      ready: isMac ? accessibilityGranted : isWindows && automaticPasteReady,
    },
    globalHold: {
      supported: isMac || isWindows,
      // Common Mac chords use the narrow native key-state monitor; rare keys
      // without a macOS virtual-key code retain the Accessibility hook. Only
      // HotkeyService can prove that the selected path actually started.
      ready: (isMac || isWindows) && globalHoldReady,
    },
    globalToggle: {
      // Every desktop platform can register an accelerator; whether this one
      // was claimed is a separate, per-run question, and it is the question
      // that was going unanswered.
      supported: true,
      ready: globalToggleReady,
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
