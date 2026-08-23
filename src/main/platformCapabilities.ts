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
  if (platform === "darwin") return platform;
  throw new Error(`LocalScribe supports only macOS; received ${platform}`);
}

export function runtimeArchitectureFor(architecture: string): "arm64" {
  if (architecture === "arm64") return architecture;
  throw new Error(`LocalScribe supports only Apple Silicon; received ${architecture}`);
}

/**
 * LocalScribe uses macOS microphone, Accessibility, and global-hotkey
 * capabilities. The renderer receives the live readiness of each path.
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
  return {
    platform,
    microphone,
    microphoneSettingsAvailable: true,
    accessibility: {
      supported: true,
      granted: accessibilityGranted,
    },
    automaticPaste: {
      supported: true,
      ready: accessibilityGranted && automaticPasteReady,
    },
    globalHold: {
      supported: true,
      // Common Mac chords use the narrow native key-state monitor; rare keys
      // without a macOS virtual-key code retain the Accessibility hook. Only
      // HotkeyService can prove that the selected path actually started.
      ready: globalHoldReady,
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
  _platform: RuntimePlatform,
  permission: PermissionKind,
): string {
  return permission === "microphone"
    ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
    : "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
}
