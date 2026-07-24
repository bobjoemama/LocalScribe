import { SerialTaskQueue } from "./serialTaskQueue";
import type {
  ActiveTarget,
  ClipboardPort,
  ClipboardSnapshot,
  InsertionOutcome,
  PasteInjectionResult,
  PasteInjector,
  PlatformInsertionBridge,
} from "./types";

export interface SafeInsertionOptions {
  /** Maximum time to wait for a target-consumption acknowledgment before retaining dictated text. */
  pasteSettleMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function sameTarget(expected: ActiveTarget, current: ActiveTarget): boolean {
  if (
    expected.platform !== current.platform ||
    expected.processId !== current.processId ||
    expected.applicationId !== current.applicationId
  ) {
    return false;
  }

  // Process identity alone cannot distinguish two windows in the same app.
  // Auto-paste therefore fails closed unless the bridge identified a focused
  // window at both boundaries.
  return (
    expected.windowFingerprint !== null &&
    current.windowFingerprint !== null &&
    expected.windowFingerprint === current.windowFingerprint
  );
}

export class SafeInsertionCoordinator {
  private readonly queue = new SerialTaskQueue();
  private readonly pasteSettleMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private pendingTarget: Promise<ActiveTarget | null> | null = null;
  private capturedTargetAppId: string | null = null;
  private captureGeneration = 0;
  // Generation zero preserves the coordinator's copy-only fallback for callers
  // that have not started target capture. Cancellation explicitly sets null so
  // a late transcription result cannot revive the cancelled session.
  private activeSessionGeneration: number | null = 0;

  constructor(
    private readonly clipboard: ClipboardPort,
    private readonly platformBridge: PlatformInsertionBridge,
    private readonly pasteInjector: PasteInjector,
    options: SafeInsertionOptions = {},
  ) {
    this.pasteSettleMs = options.pasteSettleMs ?? 90;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  /**
   * Starts capturing the target without delaying microphone startup. The
   * resulting promise is bound to the next insertion request before that
   * request enters the serial paste queue.
   */
  beginSession(): void {
    const generation = ++this.captureGeneration;
    this.activeSessionGeneration = generation;
    this.capturedTargetAppId = null;
    this.pendingTarget = this.platformBridge.captureActiveTarget()
      .then((target) => {
        if (generation === this.captureGeneration) {
          this.capturedTargetAppId = target?.applicationId ?? null;
        }
        return target;
      })
      .catch(() => {
        if (generation === this.captureGeneration) this.capturedTargetAppId = null;
        return null;
      });
  }

  cancelSession(): void {
    this.captureGeneration += 1;
    this.activeSessionGeneration = null;
    this.pendingTarget = null;
    this.capturedTargetAppId = null;
  }

  async targetAppId(): Promise<string | null> {
    if (this.pendingTarget) await this.pendingTarget;
    return this.capturedTargetAppId;
  }

  private isCurrentSession(generation: number | null): generation is number {
    return generation !== null
      && generation === this.captureGeneration
      && generation === this.activeSessionGeneration;
  }

  private async waitForConsumptionAcknowledgement(acknowledgement: Promise<void>): Promise<boolean> {
    try {
      return await Promise.race([
        acknowledgement.then(
          () => true,
          () => false,
        ),
        this.sleep(this.pasteSettleMs).then(
          () => false,
          () => false,
        ),
      ]);
    } catch {
      return false;
    }
  }

  insert(text: string, autoPaste: boolean): Promise<InsertionOutcome> {
    const insertionGeneration = this.activeSessionGeneration;
    const targetAtStart = this.pendingTarget;
    this.pendingTarget = null;

    return this.queue.run(async () => {
      // Queue entries cannot be removed once an earlier insertion is running,
      // so bind every entry to the session that created it. Cancellation or a
      // newer dictation invalidates the entry before it can touch the clipboard.
      if (!this.isCurrentSession(insertionGeneration)) return "copied";

      if (!autoPaste) {
        if (!this.isCurrentSession(insertionGeneration)) return "copied";
        this.clipboard.writeText(text);
        return "copied";
      }

      const expectedTarget = targetAtStart ? await targetAtStart : null;
      if (!this.isCurrentSession(insertionGeneration)) return "copied";
      if (!expectedTarget) {
        this.clipboard.writeText(text);
        return "copied";
      }

      // Bracket the snapshot with native sequence reads. If another process
      // changes the clipboard while it is being captured, never restore that
      // potentially mixed/stale snapshot and fall back to copy-only.
      let originalClipboard: ClipboardSnapshot;
      const sequenceBeforeSnapshot = await this.platformBridge.clipboardSequence().catch(() => null);
      if (!this.isCurrentSession(insertionGeneration)) return "copied";
      try {
        originalClipboard = this.clipboard.snapshot();
      } catch {
        if (!this.isCurrentSession(insertionGeneration)) return "copied";
        this.clipboard.writeText(text);
        return "copied";
      }
      const sequenceAfterSnapshot = await this.platformBridge.clipboardSequence().catch(() => null);
      if (!this.isCurrentSession(insertionGeneration)) return "copied";
      if (
        sequenceBeforeSnapshot === null ||
        sequenceAfterSnapshot === null ||
        sequenceBeforeSnapshot !== sequenceAfterSnapshot
      ) {
        this.clipboard.writeText(text);
        return "copied";
      }

      // Always leave the transcription available to the user. Capture the
      // target after the write so the identity check is as close to paste as
      // possible.
      if (!this.isCurrentSession(insertionGeneration)) return "copied";
      this.clipboard.writeText(text);
      const sequenceAfterWrite = await this.platformBridge.clipboardSequence().catch(() => null);
      if (!this.isCurrentSession(insertionGeneration)) return "copied";
      const currentTarget = await this.platformBridge.captureActiveTarget().catch(() => null);
      if (!this.isCurrentSession(insertionGeneration)) return "copied";
      const sequenceBeforePaste = await this.platformBridge.clipboardSequence().catch(() => null);
      if (!this.isCurrentSession(insertionGeneration)) return "copied";
      if (
        !currentTarget ||
        !sameTarget(expectedTarget, currentTarget) ||
        sequenceAfterWrite === null ||
        sequenceBeforePaste !== sequenceAfterWrite
      ) {
        return "copied";
      }

      // On macOS, do not send Command-V to a button, browser chrome, the
      // desktop, or another non-editable control. If Accessibility cannot
      // identify a writable focused element, retaining the transcription on
      // the clipboard is the safe and predictable fallback.
      if (currentTarget.platform === "darwin" && currentTarget.focusedEditable !== true) {
        return "copied";
      }

      let injection: PasteInjectionResult;
      try {
        if (!this.isCurrentSession(insertionGeneration)) return "copied";
        // Carry the target captured at dictation start across the final native
        // boundary. The helper recaptures and compares it immediately before
        // dispatch, closing the focus-change gap after this TypeScript check.
        injection = await this.pasteInjector.paste(expectedTarget);
      } catch {
        return "copied";
      }
      // A native paste already dispatched before cancellation cannot be
      // recalled. Do prevent all subsequent acknowledgement/restore work.
      if (!this.isCurrentSession(insertionGeneration)) return "copied";

      // A dispatched key event is not proof that the target has consumed the
      // clipboard. In the absence of a target-consumption acknowledgment, the
      // dictated text deliberately remains available on the clipboard.
      if (injection.status !== "injected" || !injection.consumptionAcknowledgement) {
        return injection.status === "injected" ? "pasted-with-copy" : "copied";
      }

      if (!await this.waitForConsumptionAcknowledgement(injection.consumptionAcknowledgement)) {
        return "pasted-with-copy";
      }
      if (!this.isCurrentSession(insertionGeneration)) return "pasted-with-copy";

      const sequenceBeforeRestore = await this.platformBridge.clipboardSequence().catch(() => null);
      if (!this.isCurrentSession(insertionGeneration)) return "pasted-with-copy";

      // Sequence numbers are deliberately required for restoration. A content
      // comparison cannot distinguish a user copying the same value again.
      // Platforms without an implemented sequence bridge keep the dictated
      // text on the clipboard instead of risking data loss.
      if (
        originalClipboard.restorable &&
        sequenceAfterWrite !== null &&
        sequenceBeforeRestore === sequenceAfterWrite
      ) {
        this.clipboard.restore(originalClipboard);
      }

      return "pasted";
    });
  }
}

export { sameTarget };
