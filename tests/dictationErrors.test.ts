import { describe, expect, it } from "vitest";
import {
  microphonePermissionRecovery,
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

  it("always points microphone recovery to macOS System Settings", () => {
    expect(microphonePermissionRecovery("darwin"))
      .toBe("Allow LocalScribe in System Settings > Privacy & Security > Microphone.");
    expect(microphonePermissionRecovery()).toBe(
      "Allow LocalScribe in System Settings > Privacy & Security > Microphone.",
    );
    expect(presentDictationError("NotAllowedError: Permission denied").detail)
      .toContain("System Settings");
  });

  it("turns worker and invalid-response failures into plain language", () => {
    expect(presentDictationError("ASR worker request timed out: transcribe").title).toBe("Speech engine stopped");
    expect(presentDictationError("Unexpected worker response: error")).toEqual({
      title: "Dictation could not finish",
      detail: "The local speech engine returned an invalid response. Try again.",
    });
  });

  it("normalizes both duration and byte-limit recording failures", () => {
    for (const message of [
      "Recording is too long; please keep dictation under 10 minutes",
      "Recording is too large; please keep dictation under 10 minutes",
    ]) {
      expect(presentDictationError(message)).toEqual({
        title: "Recording is too long",
        detail: "Finish the dictation sooner, then continue in a new recording.",
      });
    }
  });

  it("routes model recovery to the current model screen without assuming the active family", () => {
    for (const message of ["model_not_installed", "model_not_loaded", "model_checksum_failed"]) {
      const presentation = presentDictationError(message);
      expect(presentation.detail).toContain("Settings > Model & Performance");
      expect(presentation.detail).toContain("selected local model");
      expect(presentation.detail).not.toMatch(/Whisper|Qwen|Settings > System/i);
    }
  });

  it("turns unsupported dictionary context into plain recovery copy without claiming dictionary corrections are lost", () => {
    expect(presentDictationError(
      "context_not_supported: Parakeet Unified does not support dictionary prompts",
    )).toEqual({
      title: "This model cannot use an optional speech hint",
      detail: "Your Dictionary entries still correct finished text locally. Try again; if this repeats, quit and reopen LocalScribe, then check Settings > Model & Performance.",
    });
  });

  it("keeps safe unknown errors useful but does not expose local paths", () => {
    expect(presentDictationError("The selected audio format is unsupported").detail)
      .toBe("The selected audio format is unsupported");
    expect(presentDictationError("Failed at /Users/Alice/private/audio.wav").detail)
      .toBe("Try again. If this keeps happening, quit and reopen LocalScribe.");
    expect(presentDictationError("Missing /Applications/LocalScribe.app/Contents/Resources/worker").detail)
      .toBe("Try again. If this keeps happening, quit and reopen LocalScribe.");
    expect(presentDictationError("Failed at \\\\workstation\\private\\model.bin").detail)
      .toBe("Try again. If this keeps happening, quit and reopen LocalScribe.");
    expect(presentDictationError("Failed at C:/Users/Alice/private/audio.wav").detail)
      .toBe("Try again. If this keeps happening, quit and reopen LocalScribe.");
    expect(presentDictationError("Missing %LOCALAPPDATA%\\LocalScribe\\worker.exe").detail)
      .toBe("Try again. If this keeps happening, quit and reopen LocalScribe.");
    expect(presentDictationError("ENOENT while starting the speech worker").detail)
      .toBe("Try again. If this keeps happening, quit and reopen LocalScribe.");
    expect(presentDictationError("Failed at /workspace/private/model.bin").detail)
      .toBe("Try again. If this keeps happening, quit and reopen LocalScribe.");
    expect(presentDictationError("TypeError: failed to decode audio\n    at decode (audio.ts:12:3)").detail)
      .toBe("Try again. If this keeps happening, quit and reopen LocalScribe.");
    expect(presentDictationError("Download failed at https://models.example.test/private?token=secret").detail)
      .toBe("Try again. If this keeps happening, quit and reopen LocalScribe.");
  });

  it("normalizes whitespace and enforces the session message bound", () => {
    expect(normalizeDictationErrorMessage("  No   speech\n detected  ")).toBe("No speech detected");
    expect(normalizeDictationErrorMessage("x".repeat(500))).toHaveLength(240);
  });
});
