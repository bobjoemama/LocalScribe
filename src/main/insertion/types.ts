export interface ActiveTarget {
  platform: "darwin" | "win32";
  processId: number;
  applicationId: string;
  windowFingerprint: string | null;
  /** macOS Accessibility can confirm whether the focused control accepts text. */
  focusedEditable?: boolean | null;
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
  captureActiveTarget(): Promise<ActiveTarget | null>;
  clipboardSequence(): Promise<number | null>;
  /** Optional native path used when the helper owns macOS input permission. */
  paste?(expectedTarget: ActiveTarget): Promise<PasteInjectionResult>;
  accessibilityReady?(): Promise<boolean>;
  requestAccessibility?(): Promise<boolean>;
}

export type PasteInjectionResult =
  | {
      /** The input event was not dispatched; the dictated text remains copied. */
      status: "failed";
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
  paste(expectedTarget: ActiveTarget): PasteInjectionResult | Promise<PasteInjectionResult>;
}

export type InsertionOutcome = "pasted" | "pasted-with-copy" | "copied";
