import type { InsertionOutcome } from "./types";

export interface InsertionDiagnosticEvent {
  readonly stage: "insertion";
  readonly event: InsertionOutcome;
  readonly outcome: "ok" | "skipped";
  readonly permission: "disabled" | "not_ready" | "ready";
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
  return {
    stage: "insertion",
    event: insertionOutcome,
    outcome: insertionOutcome === "copied" ? "skipped" : "ok",
    permission: !automaticPasteEnabled
      ? "disabled"
      : automaticPasteReady
        ? "ready"
        : "not_ready",
  };
}
