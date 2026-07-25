import { describe, expect, it } from "vitest";
import { rendererSafeErrorMessage } from "../src/shared/rendererErrors";

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
});
