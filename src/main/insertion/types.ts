export interface ActiveTarget {
  platform: "darwin";
  processId: number;
  applicationId: string;
  windowFingerprint: string | null;
  /** Accessibility can confirm whether the focused control accepts text. */
  focusedEditable?: boolean | null;
  /** Opaque identity for the exact focused editable control. */
  focusedElementFingerprint?: string | null;
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

export type InsertionOutcome = "pasted" | "pasted-with-copy" | "copied";

export type PasteFailureReason =
  | "permission_denied"
  | "target_unavailable"
  | "target_changed"
  | "clipboard_changed"
  | "event_unavailable"
  | "helper_unavailable"
  | "invalid_request"
  | "invalid_response";

export type InsertionReasonCode =
  | "automatic_paste_disabled"
  | "automatic_paste_unavailable"
  | "safety_check_declined"
  | "clipboard_retained";
