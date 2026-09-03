export const ACCESSIBILITY_ELEMENT_CATEGORIES = [
  "missing",
  "web_area",
  "text_control",
  "static_text",
  "other",
] as const;

export type AccessibilityElementCategory = (typeof ACCESSIBILITY_ELEMENT_CATEGORIES)[number];

export const ACCESSIBILITY_ACTIVATION_OUTCOMES = [
  "not_needed",
  "unsupported",
  "set_failed",
  "resolved",
  "timed_out",
  "permission_denied",
] as const;

export type AccessibilityActivationOutcome = (typeof ACCESSIBILITY_ACTIVATION_OUTCOMES)[number];

export interface ActiveTarget {
  platform: "darwin";
  processId: number;
  applicationId: string;
  windowFingerprint: string | null;
  /** Accessibility can confirm whether the focused control accepts text. */
  focusedEditable?: boolean | null;
  /**
   * Opaque identity for the focused editable control at an observation
   * boundary. macOS does not make the later Accessibility-check/CGEvent post
   * atomic, so this supports best-effort paste with copy fallback.
   */
  focusedElementFingerprint?: string | null;
  /** Closed, content-free category used only for insertion diagnostics. */
  accessibilityElement?: AccessibilityElementCategory;
  /** Whether cold accessibility-tree activation was needed and what happened. */
  accessibilityActivation?: AccessibilityActivationOutcome;
  /** Bounded number of focused-element observations made by the native helper. */
  accessibilityLookupAttempts?: number;
}

export interface ClipboardSnapshot {
  text?: string;
  html?: string;
  rtf?: string;
  imagePng?: Uint8Array;
  /** False when restoring would silently discard a clipboard representation. */
  restorable: boolean;
}

export interface ClipboardPort {
  snapshot(): ClipboardSnapshot;
  writeText(text: string): void;
  restore(snapshot: ClipboardSnapshot): void;
}

export interface PlatformInsertionBridge {
  /** Pins the currently verified helper bytes for later per-spawn checks. */
  pinExecutableIntegrity?(): boolean;
  captureActiveTarget(): Promise<ActiveTarget | null>;
  clipboardSequence(): Promise<number | null>;
  /** Proves the packaged helper exists and can execute its deterministic self-test. */
  ready?(): Promise<boolean>;
  /** Optional native path used when the helper owns macOS input permission. */
  paste?(
    expectedTarget: ActiveTarget,
    expectedClipboardSequence: number,
  ): Promise<PasteInjectionResult>;
  accessibilityReady?(): Promise<boolean>;
  requestAccessibility?(): Promise<boolean>;
}

export type PasteInjectionResult =
  | {
      /** The input event was not dispatched; the dictated text remains copied. */
      status: "failed";
      /** Privacy-safe classification; never contains target or clipboard data. */
      reason?: PasteFailureReason;
    }
  | {
      /** The input event was dispatched to the operating system. */
      status: "injected";
      /**
       * Resolves only after the receiving target has consumed the clipboard
       * data for this paste. Without this explicit acknowledgment, callers
       * must leave the dictated text on the clipboard.
       */
      consumptionAcknowledgement?: Promise<void>;
    };

export interface PasteInjector {
  paste(
    expectedTarget: ActiveTarget,
    expectedClipboardSequence: number,
  ): PasteInjectionResult | Promise<PasteInjectionResult>;
}

/**
 * `pasted` requires target-consumption acknowledgement. `pasted-with-copy`
 * means only that macOS accepted the key event; it is not proof that the
 * intended control consumed it, so dictated text remains copied as fallback.
 */
export type InsertionOutcome = "pasted" | "pasted-with-copy" | "copied";

export const PASTE_FAILURE_REASONS = [
  "permission_denied",
  "target_unavailable",
  "target_changed",
  "clipboard_changed",
  "event_unavailable",
  "helper_unavailable",
  "invalid_request",
  "invalid_response",
] as const;

export type PasteFailureReason = (typeof PASTE_FAILURE_REASONS)[number];

/**
 * Closed, privacy-safe insertion classifications. These protocol constants
 * may be written to diagnostics; they must never contain target identity,
 * clipboard contents, geometry, window metadata, or dictated text.
 */
export const INSERTION_REASON_CODES = [
  "automatic_paste_disabled",
  "automatic_paste_unavailable",
  "session_invalidated",
  "initial_target_unavailable",
  "initial_target_editability_unavailable",
  "initial_target_not_editable",
  "initial_window_identity_unavailable",
  "initial_control_identity_unavailable",
  "current_target_unavailable",
  "current_target_editability_unavailable",
  "current_target_not_editable",
  "current_window_identity_unavailable",
  "current_window_changed",
  "current_control_identity_unavailable",
  "current_control_changed",
  "app_process_target_changed",
  "clipboard_snapshot_failed",
  "clipboard_sequence_unavailable",
  "paste_injection_failed",
  "paste_acknowledgement_unavailable",
  "paste_acknowledgement_failed",
  ...PASTE_FAILURE_REASONS,
] as const;

export type InsertionReasonCode = (typeof INSERTION_REASON_CODES)[number];

export interface InsertionResult {
  readonly outcome: InsertionOutcome;
  /** Omitted only when the insertion completed without a safety fallback. */
  readonly reason?: InsertionReasonCode;
  readonly accessibilityElement?: AccessibilityElementCategory;
  readonly accessibilityActivation?: AccessibilityActivationOutcome;
  readonly accessibilityLookupAttempts?: number;
}
