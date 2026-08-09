import { describe, expect, it } from "vitest";
import { insertionDiagnosticEvent } from "../src/main/insertion/insertionDiagnostics";

describe("insertion diagnostics", () => {
  it("distinguishes a disabled setting from unavailable automatic paste", () => {
    expect(insertionDiagnosticEvent("copied", false, true)).toEqual({
      stage: "insertion",
      event: "copied",
      outcome: "skipped",
      permission: "disabled",
    });
    expect(insertionDiagnosticEvent("copied", true, false)).toEqual({
      stage: "insertion",
      event: "copied",
      outcome: "skipped",
      permission: "not_ready",
    });
  });

  it("identifies a safety fallback even when permission is ready", () => {
    expect(insertionDiagnosticEvent("copied", true, true)).toEqual({
      stage: "insertion",
      event: "copied",
      outcome: "skipped",
      permission: "ready",
    });
  });

  it.each(["pasted", "pasted-with-copy"] as const)(
    "records %s as a successful native insertion",
    (outcome) => {
      expect(insertionDiagnosticEvent(outcome, true, true)).toEqual({
        stage: "insertion",
        event: outcome,
        outcome: "ok",
        permission: "ready",
      });
    },
  );
});
