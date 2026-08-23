import { describe, expect, it } from "vitest";
import { insertionDiagnosticEvent } from "../src/main/insertion/insertionDiagnostics";
import { sanitizeDiagnosticEvent } from "../src/shared/diagnosticsLog";

describe("insertion diagnostics", () => {
  it("distinguishes a disabled setting from unavailable automatic paste", () => {
    expect(insertionDiagnosticEvent("copied", false, true)).toEqual({
      stage: "insertion",
      event: "copied",
      outcome: "skipped",
      permission: "disabled",
      detail: "automatic_paste_disabled",
    });
    expect(insertionDiagnosticEvent("copied", true, false)).toEqual({
      stage: "insertion",
      event: "copied",
      outcome: "skipped",
      permission: "not_ready",
      detail: "automatic_paste_unavailable",
    });
  });

  it("identifies a safety fallback even when permission is ready", () => {
    expect(insertionDiagnosticEvent("copied", true, true)).toEqual({
      stage: "insertion",
      event: "copied",
      outcome: "skipped",
      permission: "ready",
      detail: "safety_check_declined",
    });
  });

  it("records a fully acknowledged native insertion without a failure reason", () => {
    expect(insertionDiagnosticEvent("pasted", true, true)).toEqual({
      stage: "insertion",
      event: "pasted",
      outcome: "ok",
      permission: "ready",
    });
  });

  it("records why the clipboard was retained after native dispatch", () => {
    expect(insertionDiagnosticEvent("pasted-with-copy", true, true)).toEqual({
      stage: "insertion",
      event: "pasted-with-copy",
      outcome: "ok",
      permission: "ready",
      detail: "clipboard_retained",
    });
  });

  it("survives the durable diagnostic privacy allowlist", () => {
    const event = insertionDiagnosticEvent("copied", true, true);
    expect(sanitizeDiagnosticEvent({ ...event, at: 123 })).toMatchObject({
      stage: "insertion",
      event: "copied",
      detail: "safety_check_declined",
    });
  });
});
