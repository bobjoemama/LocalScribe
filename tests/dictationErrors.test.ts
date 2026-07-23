import { describe, expect, it } from "vitest";
import {
  normalizeDictationErrorMessage,
  presentDictationError,
} from "../src/shared/dictationErrors";

describe("dictation error presentation", () => {
  it("explains a too-short Control gesture", () => {
    expect(presentDictationError("No usable audio was captured; hold the dictation key a little longer"))
      .toEqual({
        title: "That was too quick",
        detail: "Hold your push-to-talk shortcut while speaking, then release it when you are finished.",
      });
  });

  it("routes microphone permission and device failures to actionable help", () => {
    expect(presentDictationError("NotAllowedError: Permission denied").title).toBe("Microphone access is off");
    expect(presentDictationError("NotFoundError: Requested device not found").title).toBe("Microphone unavailable");
    expect(presentDictationError("NotReadableError: Could not start audio source").title).toBe("Microphone is busy");
  });

  it("turns worker and invalid-response failures into plain language", () => {
    expect(presentDictationError("ASR worker request timed out: transcribe").title).toBe("Speech engine stopped");
    expect(presentDictationError("Unexpected worker response: error")).toEqual({
      title: "Dictation could not finish",
      detail: "The local speech engine returned an invalid response. Try again.",
    });
  });

  it("routes model recovery to the current model screen without retired model names", () => {
    for (const message of ["model_not_installed", "model_not_loaded", "model_checksum_failed"]) {
      const presentation = presentDictationError(message);
      expect(presentation.detail).toContain("Settings > Model & Performance");
      expect(presentation.detail).toContain("Whisper");
      expect(presentation.detail).not.toMatch(/Qwen|Settings > System/i);
    }
  });

  it("keeps safe unknown errors useful but does not expose local paths", () => {
    expect(presentDictationError("The selected audio format is unsupported").detail)
      .toBe("The selected audio format is unsupported");
    expect(presentDictationError("Failed at /Users/devesh/private/audio.wav").detail)
      .toBe("Try again. If this keeps happening, quit and reopen LocalScribe.");
  });

  it("normalizes whitespace and enforces the session message bound", () => {
    expect(normalizeDictationErrorMessage("  No   speech\n detected  ")).toBe("No speech detected");
    expect(normalizeDictationErrorMessage("x".repeat(500))).toHaveLength(240);
  });
});
