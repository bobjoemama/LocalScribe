import { describe, expect, it } from "vitest";
import { insertionDiagnosticEvent } from "../src/main/insertion/insertionDiagnostics";
import {
  ACCESSIBILITY_ACTIVATION_OUTCOMES,
  ACCESSIBILITY_ELEMENT_CATEGORIES,
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

  it("records only closed cold-accessibility-tree metadata", () => {
    const event = insertionDiagnosticEvent({
      outcome: "copied",
      reason: "initial_target_editability_unavailable",
      accessibilityElement: "static_text",
      accessibilityActivation: "timed_out",
      accessibilityLookupAttempts: 81,
    }, true, true);

    expect(event).toMatchObject({
      accessibilityElement: "static_text",
      accessibilityActivation: "timed_out",
      accessibilityLookupAttempts: 81,
    });
    expect(sanitizeDiagnosticEvent({ ...event, at: 123 })).toMatchObject({
      accessibilityElement: "static_text",
      accessibilityActivation: "timed_out",
      accessibilityLookupAttempts: 81,
    });
    expect(sanitizeDiagnosticEvent({
      ...event,
      at: 123,
      accessibilityElement: "private target title",
      accessibilityActivation: "arbitrary state",
      accessibilityLookupAttempts: 82,
    })).not.toHaveProperty("accessibilityElement");
    expect(sanitizeDiagnosticEvent({
      ...event,
      at: 123,
      accessibilityElement: "private target title",
      accessibilityActivation: "arbitrary state",
      accessibilityLookupAttempts: 22,
    })).not.toHaveProperty("accessibilityActivation");
    expect(sanitizeDiagnosticEvent({
      ...event,
      at: 123,
      accessibilityElement: "private target title",
      accessibilityActivation: "arbitrary state",
      accessibilityLookupAttempts: 82,
    })).not.toHaveProperty("accessibilityLookupAttempts");
  });

  it("keeps native insertion vocabularies reachable through the durable allowlist", () => {
    for (const accessibilityElement of ACCESSIBILITY_ELEMENT_CATEGORIES) {
      expect(sanitizeDiagnosticEvent({
        at: 123,
        stage: "insertion",
        event: "copied",
        outcome: "skipped",
        accessibilityElement,
      }).accessibilityElement).toBe(accessibilityElement);
    }
    for (const accessibilityActivation of ACCESSIBILITY_ACTIVATION_OUTCOMES) {
      expect(sanitizeDiagnosticEvent({
        at: 123,
        stage: "insertion",
        event: "copied",
        outcome: "skipped",
        accessibilityActivation,
      }).accessibilityActivation).toBe(accessibilityActivation);
    }
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
