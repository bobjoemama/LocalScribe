export interface AccessibilityHotkeyService {
  start(): void;
  startFallback(): void;
}

type WarningSink = (message: string, error: unknown) => void;

/**
 * Reconciles macOS Accessibility changes without allowing the rare-key hook
 * start/stop failures to escape an interval callback into Electron's main
 * process. Common chords stay on the permission-free monitor in both states;
 * a later interval tick remains free to retry either path.
 */
export function reconcileAccessibilityHotkeys(
  accessibilityGranted: boolean,
  hotkeys: AccessibilityHotkeyService,
  warn: WarningSink = console.warn,
): void {
  if (!accessibilityGranted) {
    try {
      hotkeys.startFallback();
    } catch (error) {
      warn("Global hold-to-talk could not fall back after Accessibility changed", error);
    }
    return;
  }

  try {
    hotkeys.start();
  } catch (error) {
    warn("Global hold-to-talk could not start after Accessibility changed", error);
    try {
      hotkeys.startFallback();
    } catch (fallbackError) {
      warn("Global hold-to-talk fallback could not start after Accessibility changed", fallbackError);
    }
  }
}
