import type { InsertionOutcome, InsertionReasonCode } from "./types";

export interface InsertionDiagnosticEvent {
  readonly stage: "insertion";
  readonly event: InsertionOutcome;
  readonly outcome: "ok" | "skipped";
  readonly permission: "disabled" | "not_ready" | "ready";
  /** Privacy-safe reason classification; contains no dictated or target data. */
  readonly detail?: InsertionReasonCode;
}

/**
 * Describes the insertion boundary without recording target identity, clipboard
 * contents, or dictated text. A copy-only outcome with `permission: ready`
 * means a target/clipboard safety check declined injection; `not_ready` means
 * macOS Accessibility or the native bridge was unavailable.
 */
export function insertionDiagnosticEvent(
  insertionOutcome: InsertionOutcome,
  automaticPasteEnabled: boolean,
  automaticPasteReady: boolean,
): InsertionDiagnosticEvent {
  const permission = !automaticPasteEnabled
    ? "disabled"
    : automaticPasteReady
      ? "ready"
      : "not_ready";
  const reason: InsertionReasonCode | undefined = insertionOutcome === "pasted"
    ? undefined
    : insertionOutcome === "pasted-with-copy"
      ? "clipboard_retained"
      : permission === "disabled"
        ? "automatic_paste_disabled"
        : permission === "not_ready"
          ? "automatic_paste_unavailable"
          : "safety_check_declined";
  return {
    stage: "insertion",
    event: insertionOutcome,
    outcome: insertionOutcome === "copied" ? "skipped" : "ok",
    permission,
    ...(reason ? { detail: reason } : {}),
  };
}
