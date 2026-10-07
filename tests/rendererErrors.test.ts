import { describe, expect, it, vi } from "vitest";
import { rendererKnownErrorCode, rendererSafeErrorMessage } from "../src/shared/rendererErrors";

const FALLBACK = "The item could not be loaded. Try again.";

describe("renderer-safe error presentation", () => {
  it("preserves concise user-facing messages and bounds their length", () => {
    expect(rendererSafeErrorMessage("  Database   temporarily unavailable.  ", FALLBACK))
      .toBe("Database temporarily unavailable.");
    expect(rendererSafeErrorMessage(
      "Error invoking remote method 'history:list': Error: History is temporarily unavailable.",
      FALLBACK,
    )).toBe("History is temporarily unavailable.");
    expect(rendererSafeErrorMessage("x".repeat(300), FALLBACK)).toHaveLength(160);
    expect(rendererSafeErrorMessage(null, FALLBACK)).toBe(FALLBACK);
  });

  it.each([
    "Failed at C:\\Users\\Alice\\AppData\\Local\\LocalScribe\\model.bin",
    "Failed at C:/Users/Alice/AppData/Local/LocalScribe/model.bin",
    "Failed at \\\\workstation\\private\\model.bin",
    "Missing %USERPROFILE%\\AppData\\Local\\LocalScribe\\worker.exe",
    "Missing %PROFILE%/LocalScribe/worker.exe",
    "Failed at /Users/alice/Library/Application Support/LocalScribe/model.bin",
    "Failed at /home/alice/.local/share/localscribe/model.bin",
    "Failed at /root/.cache/localscribe/model.bin",
    "Failed at /workspace/alice/private/model.bin",
    "Failed at ~/Library/Application Support/LocalScribe/model.bin",
    "Download failed at https://models.example.test/private?token=secret",
  ])("redacts a machine-local path from %s", (message) => {
    expect(rendererSafeErrorMessage(message, FALLBACK)).toBe(FALLBACK);
  });

  it.each([
    "ENOENT while opening the local database",
    "SQLITE_CANTOPEN: unable to open database file",
    "Error: failed\n    at loadCatalog (modelCatalog.ts:42:7)",
    "Traceback (most recent call last): File \"worker.py\", line 42",
    "The worker exited with stderr output",
    "ASR worker request timed out: transcribe",
    "Failure in modelCatalog.ts:42:7",
    "Invalid JSON returned from the local runtime",
    "TypeError: Cannot read properties of undefined",
    "[{\"code\":\"invalid_type\",\"path\":[\"model\"]}]",
    "spawn python.exe failed",
  ])("redacts technical diagnostics from %s", (message) => {
    expect(rendererSafeErrorMessage(new Error(message), FALLBACK)).toBe(FALLBACK);
  });

  it("does not allow an unsafe caller fallback to reintroduce a path", () => {
    expect(rendererSafeErrorMessage(null, "Failed at C:\\Users\\Alice\\private.db"))
      .toBe("The local operation failed. Try again.");
  });

  it("does not surface backend error-code tokens as if they were instructions", () => {
    expect(rendererSafeErrorMessage(
      "context_not_supported: Parakeet Unified does not support dictionary prompts",
      FALLBACK,
    )).toBe(FALLBACK);
  });
});


describe("closed renderer operational codes", () => {
  const allowed = new Set(["audio_storage_unavailable", "audio_storage_full"]);

  it("accepts exact own codes and IPC message prefixes without returning backend prose", () => {
    const failure = Object.assign(new Error("private recorded text /Users/Alice/audio.wav"), { code: "audio_storage_full" });
    expect(rendererKnownErrorCode(failure, allowed)).toBe("audio_storage_full");
    expect(rendererKnownErrorCode({ code: "audio_storage_full", message: "token=secret" }, allowed)).toBe("audio_storage_full");
    expect(rendererKnownErrorCode("Error invoking remote method 'session:transcribe': Error: audio_storage_unavailable: /Users/Alice/private.wav", allowed)).toBe("audio_storage_unavailable");
    expect(rendererKnownErrorCode("private text mentioning audio_storage_full", allowed)).toBeUndefined();
    expect(rendererKnownErrorCode({ code: "pin_1234", message: "private text" }, allowed)).toBeUndefined();
    expect(rendererKnownErrorCode(Object.assign(new Error("private text"), { code: "pin_1234" }), allowed)).toBeUndefined();
  });

  it("follows bounded data causes and terminates on cycles", () => {
    const inner = Object.assign(new Error("private text"), { code: "audio_storage_full" });
    expect(rendererKnownErrorCode(new Error("Wrapped", { cause: inner }), allowed)).toBe("audio_storage_full");
    let wrapped: Error = inner;
    for (let depth = 0; depth < 8; depth += 1) wrapped = new Error("Wrapped", { cause: wrapped });
    expect(rendererKnownErrorCode(wrapped, allowed)).toBeUndefined();
    const cycle = new Error("Wrapped");
    Object.defineProperty(cycle, "cause", { value: cycle });
    expect(rendererKnownErrorCode(cycle, allowed)).toBeUndefined();
  });

  it("does not execute accessors or inherited attacker-provided fields", () => {
    const getter = vi.fn(() => { throw new Error("Do not run"); });
    const failure = Object.create({ code: "audio_storage_full" }) as object;
    for (const property of ["code", "message", "cause"]) Object.defineProperty(failure, property, { get: getter });
    expect(rendererKnownErrorCode(failure, allowed)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
    expect(rendererKnownErrorCode(Object.create({ code: "audio_storage_full" }), allowed)).toBeUndefined();
  });
});
