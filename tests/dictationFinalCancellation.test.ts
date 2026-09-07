import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { SafeInsertionCoordinator } from "../src/main/insertion/safeInsertion";
import type { SessionSnapshot } from "../src/shared/contracts";

// Exercise the actual main-process completion function without starting
// Electron or opening a user's database, clipboard, or microphone.
const source = ts.createSourceFile(
  "main.ts",
  readFileSync("src/main.ts", "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const completion = source.statements.find((statement) => (
  ts.isFunctionDeclaration(statement) && statement.name?.text === "completeDictationFinal"
));
if (!completion) throw new Error("Missing main-process dictation completion function");
const javascript = ts.transpileModule(completion.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function harness() {
  let activeSessionId: string | null = "original";
  let snapshot: SessionSnapshot = { state: "transcribing", sessionId: "original" };
  let releaseReadiness!: (ready: boolean) => void;
  let enteredReadiness!: () => void;
  const readinessEntered = new Promise<void>((resolve) => { enteredReadiness = resolve; });
  const readiness = new Promise<boolean>((resolve) => { releaseReadiness = resolve; });
  const writeText = vi.fn();
  const coordinator = new SafeInsertionCoordinator(
    { writeText, snapshot: vi.fn(), restore: vi.fn() },
    { captureActiveTarget: async () => null, clipboardSequence: async () => null },
    { paste: async () => ({ status: "failed" }) },
  );
  coordinator.beginSession();
  const copyAndPasteDetailed = vi.fn((text: string, autoPaste: boolean) => coordinator.insert(text, autoPaste));
  const setSession = vi.fn((next: SessionSnapshot) => { snapshot = next; });
  const persistHistory = vi.fn(() => ({ record: { text: "Original dictation" } }));
  const dependencies = {
    database: { listDictionary: () => [], listSnippets: () => [], findProfile: () => null },
    insertion: {
      targetAppId: () => coordinator.targetAppId(),
      automaticPasteReady: () => { enteredReadiness(); return readiness; },
      copyAndPasteDetailed,
    },
    sanitizeSourceApplicationId: (value: string | null) => value,
    assertActiveSession: (sessionId: string) => {
      if (sessionId !== activeSessionId) throw new Error("Dictation was cancelled");
    },
    transformDictation: (text: string) => ({ text }),
    applyLocalTextRules: (text: string) => text,
    settingsWindow: null,
    scratchpadWindow: null,
    setSession,
    diagnostics: { record: vi.fn() },
    insertionDiagnosticEvent: () => ({}),
    persistCompletedDictationHistory: persistHistory,
    notifyHistoryChanged: vi.fn(),
  };
  const complete = new Function(
    ...Object.keys(dependencies),
    `${javascript}\nreturn completeDictationFinal;`,
  )(...Object.values(dependencies)) as (input: unknown) => Promise<unknown>;

  return {
    start: () => complete({
      sessionId: "original",
      durationMs: 1_000,
      settings: { autoPaste: true, keepHistory: true },
      resolution: { tier: { manifest: { modelId: "test" } } },
      result: { text: "Original dictation", language: "en" },
    }),
    cancel: (restart: boolean) => {
      coordinator.cancelSession();
      activeSessionId = null;
      snapshot = { state: "idle" };
      if (restart) {
        activeSessionId = "newer";
        snapshot = { state: "listening", sessionId: "newer" };
        coordinator.beginSession();
      }
    },
    readinessEntered,
    releaseReadiness,
    snapshot: () => snapshot,
    writeText,
    copyAndPasteDetailed,
    setSession,
    persistHistory,
  };
}

describe("dictation completion after native permission readiness", () => {
  it.each([false, true])("respects cancellation while readiness is pending (restart=%s)", async (restart) => {
    const h = harness();
    const result = h.start();
    const rejected = expect(result).rejects.toThrow("Dictation was cancelled");
    await h.readinessEntered;
    h.cancel(restart);
    h.releaseReadiness(true);
    await rejected;

    expect(h.snapshot()).toEqual(restart ? { state: "listening", sessionId: "newer" } : { state: "idle" });
    expect(h.setSession).not.toHaveBeenCalled();
    expect(h.copyAndPasteDetailed).not.toHaveBeenCalled();
    expect(h.writeText).not.toHaveBeenCalled();
    expect(h.persistHistory).not.toHaveBeenCalled();
  });

  it("still delivers and saves the current session after readiness resolves", async () => {
    const h = harness();
    const result = h.start();
    await h.readinessEntered;
    h.releaseReadiness(true);
    await expect(result).resolves.toEqual({ text: "Original dictation" });
    expect(h.writeText).toHaveBeenCalledWith("Original dictation");
    expect(h.snapshot().state).toBe("success");
    expect(h.persistHistory).toHaveBeenCalledOnce();
  });
});
