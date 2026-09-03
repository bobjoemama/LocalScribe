import type {
  AccessibilityActivationOutcome,
  AccessibilityElementCategory,
  InsertionOutcome,
  InsertionReasonCode,
  InsertionResult,
} from "./types";

export interface InsertionDiagnosticEvent {
  readonly stage: "insertion";
  readonly event: InsertionOutcome;
  readonly outcome: "ok" | "skipped";
  readonly permission: "disabled" | "not_ready" | "ready";
  /** Privacy-safe reason classification; contains no dictated or target data. */
  readonly detail?: InsertionReasonCode;
  readonly accessibilityElement?: AccessibilityElementCategory;
  readonly accessibilityActivation?: AccessibilityActivationOutcome;
  readonly accessibilityLookupAttempts?: number;
}

/**
 * Describes the insertion boundary without recording target identity, clipboard
 * contents, or dictated text. Copy-only results preserve a closed reason code
 * from the coordinator; permission state takes precedence when automatic paste
 * was disabled or unavailable before the coordinator ran.
 */
export function insertionDiagnosticEvent(
  insertionResult: InsertionResult,
  automaticPasteEnabled: boolean,
  automaticPasteReady: boolean,
): InsertionDiagnosticEvent {
  const insertionOutcome = insertionResult.outcome;
  const permission = !automaticPasteEnabled
    ? "disabled"
    : automaticPasteReady
      ? "ready"
      : "not_ready";
  const reason: InsertionReasonCode | undefined = insertionOutcome === "pasted"
    ? undefined
    : permission === "disabled"
      ? "automatic_paste_disabled"
      : permission === "not_ready"
        ? "automatic_paste_unavailable"
        : insertionResult.reason;
  return {
    stage: "insertion",
    event: insertionOutcome,
    outcome: insertionOutcome === "copied" ? "skipped" : "ok",
    permission,
    ...(reason ? { detail: reason } : {}),
    ...(insertionResult.accessibilityElement === undefined
      ? {}
      : { accessibilityElement: insertionResult.accessibilityElement }),
    ...(insertionResult.accessibilityActivation === undefined
      ? {}
      : { accessibilityActivation: insertionResult.accessibilityActivation }),
    ...(insertionResult.accessibilityLookupAttempts === undefined
      ? {}
      : { accessibilityLookupAttempts: insertionResult.accessibilityLookupAttempts }),
  };
}
