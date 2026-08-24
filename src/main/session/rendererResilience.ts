import type { SessionState } from "../../shared/contracts";
import type { RendererSurface } from "../rendererProtocol";

/** Minimal Electron shape needed for a best-effort renderer broadcast. */
export interface RendererEndpoint {
  isDestroyed(): boolean;
  readonly webContents: {
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
  };
}

/**
 * Sends an observational update without letting a torn-down renderer change
 * the main-process transaction that produced it.
 *
 * Every Electron access is inside the try block. In particular,
 * `window.webContents` can throw while Chromium is tearing a window down even
 * when the preceding `isDestroyed()` read returned false.
 */
export function sendToLiveRenderers(
  windows: ReadonlyArray<RendererEndpoint | null>,
  channel: string,
  payload: unknown,
  onFailure: (error: unknown) => void,
): number {
  let delivered = 0;
  for (const window of windows) {
    if (!window) continue;
    try {
      if (window.isDestroyed()) continue;
      const contents = window.webContents;
      if (contents.isDestroyed()) continue;
      contents.send(channel, payload);
      delivered += 1;
    } catch (error) {
      try {
        onFailure(error);
      } catch {
        // Failure reporting is observational too. Keep delivering to later
        // renderers even if a custom logger is itself unavailable.
      }
    }
  }
  return delivered;
}

export interface RendererFailureRecoveryPolicy {
  /** Cancel/fail capture only when the renderer that owns capture dies. */
  readonly failActiveDictation: boolean;
  /** Create at most one automatic replacement for this failed generation. */
  readonly recreate: boolean;
  /** Restore visibility without activating the replacement window. */
  readonly restoreVisibleInactive: boolean;
}

/** Pure policy kept separate from Electron event timing for exhaustive tests. */
export function rendererFailureRecoveryPolicy(input: {
  surface: RendererSurface;
  quitting: boolean;
  hasActiveDictation: boolean;
  recoveryAlreadyInFlight: boolean;
  wasVisible: boolean;
}): RendererFailureRecoveryPolicy {
  if (input.quitting) {
    return {
      failActiveDictation: false,
      recreate: false,
      restoreVisibleInactive: false,
    };
  }
  const recreate = !input.recoveryAlreadyInFlight;
  return {
    failActiveDictation: input.surface === "pill" && input.hasActiveDictation,
    recreate,
    restoreVisibleInactive: recreate && input.wasVisible,
  };
}

export type DictationMenuAction = "start" | "stop" | null;

/** Truthful label/action for both the app menu and tray menu. */
export function dictationMenuPolicy(
  state: SessionState,
  modelOperationBusy: boolean,
): { label: string; enabled: boolean; action: DictationMenuAction } {
  if (state === "listening") {
    return { label: "Stop Dictating", enabled: true, action: "stop" };
  }
  switch (state) {
    case "finalizing":
      return { label: "Finishing Recording…", enabled: false, action: null };
    case "transcribing":
      return { label: "Transcribing…", enabled: false, action: null };
    case "inserting":
      return { label: "Inserting Text…", enabled: false, action: null };
    case "idle":
    case "success":
    case "error":
      return modelOperationBusy
        ? { label: "Model Operation in Progress…", enabled: false, action: null }
        : { label: "Start Dictating", enabled: true, action: "start" };
  }
}
