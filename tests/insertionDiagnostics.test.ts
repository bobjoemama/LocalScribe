import { describe, expect, it } from "vitest";
import { insertionDiagnosticEvent } from "../src/main/insertion/insertionDiagnostics";
import {
  INSERTION_REASON_CODES,
} from "../src/main/insertion/types";
import { sanitizeDiagnosticEvent } from "../src/shared/diagnosticsLog";

describe("insertion diagnostics", () => {
  it("distinguishes a disabled setting from unavailable automatic paste", () => {
    expect(insertionDiagnosticEvent({
      outcome: "copied",
      reason: "automatic_paste_disabled",
    }, false, true)).toEqual({
      stage: "insertion",
      event: "copied",
      outcome: "skipped",
      permission: "disabled",
      detail: "automatic_paste_disabled",
    });
    expect(insertionDiagnosticEvent({
      outcome: "copied",
      reason: "automatic_paste_disabled",
    }, true, false)).toEqual({
      stage: "insertion",
      event: "copied",
      outcome: "skipped",
      permission: "not_ready",
      detail: "automatic_paste_unavailable",
    });
  });

  it("preserves the coordinator's specific safety reason when permission is ready", () => {
    expect(insertionDiagnosticEvent({
      outcome: "copied",
      reason: "current_control_changed",
    }, true, true)).toEqual({
      stage: "insertion",
      event: "copied",
      outcome: "skipped",
      permission: "ready",
      detail: "current_control_changed",
    });
  });

  it("records a fully acknowledged native insertion without a failure reason", () => {
    expect(insertionDiagnosticEvent({ outcome: "pasted" }, true, true)).toEqual({
      stage: "insertion",
      event: "pasted",
      outcome: "ok",
      permission: "ready",
    });
  });

  it("records why the clipboard was retained after native dispatch", () => {
    expect(insertionDiagnosticEvent({
      outcome: "pasted-with-copy",
      reason: "paste_acknowledgement_unavailable",
    }, true, true)).toEqual({
      stage: "insertion",
      event: "pasted-with-copy",
      outcome: "ok",
      permission: "ready",
      detail: "paste_acknowledgement_unavailable",
    });
  });

  it("survives the durable diagnostic privacy allowlist", () => {
    const event = insertionDiagnosticEvent({
      outcome: "copied",
      reason: "clipboard_snapshot_failed",
    }, true, true);
    expect(sanitizeDiagnosticEvent({ ...event, at: 123 })).toMatchObject({
      stage: "insertion",
      event: "copied",
      detail: "clipboard_snapshot_failed",
    });
  });

  it("preserves every closed reason code without adding target or clipboard fields", () => {
    for (const reason of INSERTION_REASON_CODES) {
      const event = insertionDiagnosticEvent({
        outcome: reason.startsWith("paste_acknowledgement_") ? "pasted-with-copy" : "copied",
        reason,
      }, true, true);
      expect(event.detail).toBe(reason);
      expect(Object.keys(event).sort()).toEqual([
        "detail",
        "event",
        "outcome",
        "permission",
        "stage",
      ]);
      expect(reason).toMatch(/^[a-z0-9_]{1,64}$/u);
    }
  });
});
