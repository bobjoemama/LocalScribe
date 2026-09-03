import { SerialTaskQueue } from "./serialTaskQueue";
import type {
  ActiveTarget,
  ClipboardPort,
  ClipboardSnapshot,
  InsertionOutcome,
  InsertionReasonCode,
  InsertionResult,
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
  const sameWindow = (
    expected.windowFingerprint !== null &&
    current.windowFingerprint !== null &&
    expected.windowFingerprint === current.windowFingerprint
  );
  if (!sameWindow) return false;
  return (
    typeof expected.focusedElementFingerprint === "string"
    && typeof current.focusedElementFingerprint === "string"
    && expected.focusedElementFingerprint === current.focusedElementFingerprint
  );
}

function clipboardAdvancedExactlyOnce(
  before: number,
  after: number,
): boolean {
  if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after)) return false;
  return before >= 0 && after === before + 1;
}

function initialTargetFailure(target: ActiveTarget): InsertionReasonCode | null {
  // Check editability before identity availability so a non-editable starting
  // control is diagnosed accurately even when Accessibility omits fingerprints.
  if (target.focusedEditable == null) return "initial_target_editability_unavailable";
  if (!target.focusedEditable) return "initial_target_not_editable";
  if (target.windowFingerprint === null) return "initial_window_identity_unavailable";
  if (typeof target.focusedElementFingerprint !== "string") {
    return "initial_control_identity_unavailable";
  }
  return null;
}

function shouldRetryColdAccessibilityCapture(target: ActiveTarget): boolean {
  return target.accessibilityActivation === "resolved"
    || target.accessibilityActivation === "timed_out";
}

function sameApplicationProcess(expected: ActiveTarget, current: ActiveTarget): boolean {
  return expected.platform === current.platform
    && expected.processId === current.processId
    && expected.applicationId === current.applicationId;
}

function currentTargetFailure(
  expected: ActiveTarget,
  current: ActiveTarget,
): InsertionReasonCode | null {
  if (
    expected.platform !== current.platform
    || expected.processId !== current.processId
    || expected.applicationId !== current.applicationId
  ) {
    return "app_process_target_changed";
  }
  // As above, editability is evidence in its own right and is checked before
  // opaque identity availability. No target metadata leaves this function.
  if (current.focusedEditable == null) return "current_target_editability_unavailable";
  if (!current.focusedEditable) return "current_target_not_editable";
  if (current.windowFingerprint === null) return "current_window_identity_unavailable";
  if (expected.windowFingerprint !== current.windowFingerprint) return "current_window_changed";
  if (typeof current.focusedElementFingerprint !== "string") {
    return "current_control_identity_unavailable";
  }
  if (expected.focusedElementFingerprint !== current.focusedElementFingerprint) {
    return "current_control_changed";
  }
  return null;
}

function result(
  outcome: InsertionOutcome,
  reason?: InsertionReasonCode,
  target?: ActiveTarget,
): InsertionResult {
  return {
    outcome,
    ...(reason === undefined ? {} : { reason }),
    ...(target?.accessibilityElement === undefined
      ? {}
      : { accessibilityElement: target.accessibilityElement }),
    ...(target?.accessibilityActivation === undefined
      ? {}
      : { accessibilityActivation: target.accessibilityActivation }),
    ...(target?.accessibilityLookupAttempts === undefined
      ? {}
      : { accessibilityLookupAttempts: target.accessibilityLookupAttempts }),
  };
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
    this.pendingTarget = (async (): Promise<ActiveTarget | null> => {
      const firstTarget = await this.platformBridge.captureActiveTarget().catch(() => null);
      if (!this.isCurrentSession(generation)) return null;
      if (!firstTarget || !shouldRetryColdAccessibilityCapture(firstTarget)) {
        return firstTarget;
      }

      // AXManualAccessibility can make the target application's focused
      // control visible only after the first helper process has returned. Give
      // that one cold-start boundary exactly one fresh observation. This is
      // deliberately not a general target retry: the first observation must
      // report a completed/bounded activation attempt, and the second may only
      // replace it when application and process identity remain pinned.
      const secondTarget = await this.platformBridge.captureActiveTarget().catch(() => null);
      if (!this.isCurrentSession(generation)) return null;
      if (!secondTarget || !sameApplicationProcess(firstTarget, secondTarget)) {
        return firstTarget;
      }
      return secondTarget;
    })()
      .then((target) => {
        if (this.isCurrentSession(generation)) {
          this.capturedTargetAppId = target?.applicationId ?? null;
        }
        return target;
      })
      .catch(() => {
        if (this.isCurrentSession(generation)) this.capturedTargetAppId = null;
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

  insert(text: string, autoPaste: boolean): Promise<InsertionResult> {
    const insertionGeneration = this.activeSessionGeneration;
    const targetAtStart = this.pendingTarget;
    this.pendingTarget = null;

    return this.queue.run(async () => {
      // Queue entries cannot be removed once an earlier insertion is running,
      // so bind every entry to the session that created it. Cancellation or a
      // newer dictation invalidates the entry before it can touch the clipboard.
      if (!this.isCurrentSession(insertionGeneration)) return result("copied", "session_invalidated");

      if (!autoPaste) {
        if (!this.isCurrentSession(insertionGeneration)) return result("copied", "session_invalidated");
        this.clipboard.writeText(text);
        return result("copied", "automatic_paste_disabled");
      }

      const expectedTarget = targetAtStart ? await targetAtStart : null;
      if (!this.isCurrentSession(insertionGeneration)) return result("copied", "session_invalidated");
      if (!expectedTarget) {
        this.clipboard.writeText(text);
        return result("copied", "initial_target_unavailable");
      }
      const initialFailure = initialTargetFailure(expectedTarget);
      if (initialFailure) {
        this.clipboard.writeText(text);
        return result("copied", initialFailure, expectedTarget);
      }

      // Bracket the snapshot with native sequence reads. If another process
      // changes the clipboard while it is being captured, never restore that
      // potentially mixed/stale snapshot and fall back to copy-only.
      let originalClipboard: ClipboardSnapshot;
      const sequenceBeforeSnapshot = await this.platformBridge.clipboardSequence().catch(() => null);
      if (!this.isCurrentSession(insertionGeneration)) return result("copied", "session_invalidated");
      try {
        originalClipboard = this.clipboard.snapshot();
      } catch {
        if (!this.isCurrentSession(insertionGeneration)) return result("copied", "session_invalidated");
        this.clipboard.writeText(text);
        return result("copied", "clipboard_snapshot_failed", expectedTarget);
      }
      const sequenceAfterSnapshot = await this.platformBridge.clipboardSequence().catch(() => null);
      if (!this.isCurrentSession(insertionGeneration)) return result("copied", "session_invalidated");
      if (
        sequenceBeforeSnapshot === null ||
        sequenceAfterSnapshot === null
      ) {
        this.clipboard.writeText(text);
        return result("copied", "clipboard_sequence_unavailable", expectedTarget);
      }
      if (sequenceBeforeSnapshot !== sequenceAfterSnapshot) {
        this.clipboard.writeText(text);
        return result("copied", "clipboard_changed", expectedTarget);
      }

      // Always leave the transcription available to the user. Capture the
      // target after the write so the identity check is as close to paste as
      // possible.
      if (!this.isCurrentSession(insertionGeneration)) return result("copied", "session_invalidated");
      this.clipboard.writeText(text);
      const sequenceAfterWrite = await this.platformBridge.clipboardSequence().catch(() => null);
      if (!this.isCurrentSession(insertionGeneration)) return result("copied", "session_invalidated");
      if (sequenceAfterWrite === null) {
        return result("copied", "clipboard_sequence_unavailable", expectedTarget);
      }
      if (!clipboardAdvancedExactlyOnce(sequenceAfterSnapshot, sequenceAfterWrite)) {
        // Our synchronous clipboard write must be the only change since the
        // stable snapshot boundary. Otherwise a concurrent writer may have
        // replaced the text before this first post-write sequence read.
        return result("copied", "clipboard_changed", expectedTarget);
      }
      const currentTarget = await this.platformBridge.captureActiveTarget().catch(() => null);
      if (!this.isCurrentSession(insertionGeneration)) return result("copied", "session_invalidated");
      const sequenceBeforePaste = await this.platformBridge.clipboardSequence().catch(() => null);
      if (!this.isCurrentSession(insertionGeneration)) return result("copied", "session_invalidated");
      if (!currentTarget) return result("copied", "current_target_unavailable", expectedTarget);
      const currentFailure = currentTargetFailure(expectedTarget, currentTarget);
      if (currentFailure) return result("copied", currentFailure, currentTarget);
      if (sequenceBeforePaste === null) {
        return result("copied", "clipboard_sequence_unavailable", currentTarget);
      }
      if (sequenceBeforePaste !== sequenceAfterWrite) {
        return result("copied", "clipboard_changed", currentTarget);
      }

      let injection: PasteInjectionResult;
      try {
        if (!this.isCurrentSession(insertionGeneration)) return result("copied", "session_invalidated");
        // Carry the target captured at dictation start across the final native
        // boundary. The helper recaptures and compares it immediately before
        // dispatch, shrinking the focus-change interval after this TypeScript
        // check. macOS provides no atomic compare-and-CGEvent-post operation.
        injection = await this.pasteInjector.paste(
          expectedTarget,
          sequenceBeforePaste,
        );
      } catch {
        return result("copied", "paste_injection_failed", currentTarget);
      }
      // A native paste already dispatched before cancellation cannot be
      // recalled. Do prevent all subsequent acknowledgement/restore work.
      if (!this.isCurrentSession(insertionGeneration)) return result("copied", "session_invalidated");

      // A dispatched key event is not proof that the target has consumed the
      // clipboard. In the absence of a target-consumption acknowledgment, the
      // dictated text deliberately remains available on the clipboard.
      if (injection.status !== "injected" || !injection.consumptionAcknowledgement) {
        return injection.status === "injected"
          ? result("pasted-with-copy", "paste_acknowledgement_unavailable", currentTarget)
          : result("copied", injection.reason ?? "paste_injection_failed", currentTarget);
      }

      if (!await this.waitForConsumptionAcknowledgement(injection.consumptionAcknowledgement)) {
        return result("pasted-with-copy", "paste_acknowledgement_failed", currentTarget);
      }
      if (!this.isCurrentSession(insertionGeneration)) return result("pasted-with-copy", "session_invalidated");

      const sequenceBeforeRestore = await this.platformBridge.clipboardSequence().catch(() => null);
      if (!this.isCurrentSession(insertionGeneration)) return result("pasted-with-copy", "session_invalidated");

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

      return result("pasted", undefined, currentTarget);
    });
  }
}

export { clipboardAdvancedExactlyOnce, sameTarget };
