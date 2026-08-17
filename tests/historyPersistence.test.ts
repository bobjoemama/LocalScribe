import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  HISTORY_RETENTION_WARNING,
  HISTORY_SAVE_WARNING,
  persistCompletedDictationHistory,
  type HistoryPersistenceDependencies,
} from "../src/main/session/historyPersistence";
import type { Transcription } from "../src/shared/contracts";
import { expectPrecedes, sliceBetween } from "./support/order";

const transient: Transcription = {
  id: "11111111-2222-4333-8444-555555555555",
  createdAt: 1,
  durationMs: 2_000,
  text: "delivered text",
  language: "en",
  modelId: "whisper-large-v3-turbo",
  status: "complete",
  sourceAppId: null,
};

const saved: Transcription = {
  ...transient,
  id: "99999999-2222-4333-8444-555555555555",
};

function dependencies(
  overrides: Partial<HistoryPersistenceDependencies> = {},
): HistoryPersistenceDependencies {
  return {
    transientRecord: () => transient,
    save: () => saved,
    purgeExpired: () => 0,
    notifyChanged: vi.fn(),
    recordFailure: vi.fn(),
    ...overrides,
  };
}

describe("completed-dictation history persistence", () => {
  it("uses concise success warnings that keep the delivered result distinct from a dictation error", () => {
    expect(HISTORY_SAVE_WARNING).toBe("Done; history not saved");
    expect(HISTORY_RETENTION_WARNING).toBe("Done; history cleanup failed");
  });

  it("returns the durable record and refreshes history after a normal save", () => {
    const deps = dependencies({ purgeExpired: () => 2 });

    const result = persistCompletedDictationHistory(true, deps);

    expect(result).toEqual({ record: saved });
    expect(deps.notifyChanged).toHaveBeenCalledTimes(2);
    expect(deps.recordFailure).not.toHaveBeenCalled();
  });

  it("keeps a delivered dictation successful when saving history fails", () => {
    const error = Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" });
    const purgeExpired = vi.fn(() => 0);
    const deps = dependencies({
      save: () => {
        throw error;
      },
      purgeExpired,
    });

    const result = persistCompletedDictationHistory(true, deps);

    expect(result).toEqual({ record: transient, warning: HISTORY_SAVE_WARNING });
    expect(purgeExpired).not.toHaveBeenCalled();
    expect(deps.notifyChanged).not.toHaveBeenCalled();
    expect(deps.recordFailure).toHaveBeenCalledWith("history_save", error);
  });

  it("keeps a saved dictation successful when retention cleanup fails", () => {
    const error = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const deps = dependencies({
      purgeExpired: () => {
        throw error;
      },
    });

    const result = persistCompletedDictationHistory(true, deps);

    expect(result).toEqual({ record: saved, warning: HISTORY_RETENTION_WARNING });
    // The newly saved row is still immediately visible even if cleanup cannot
    // finish. Retrying the purge later is safer than hiding a durable row.
    expect(deps.notifyChanged).toHaveBeenCalledTimes(1);
    expect(deps.recordFailure).toHaveBeenCalledWith("history_retention", error);
  });

  it("reports a retention failure even when history saving is disabled", () => {
    const error = new Error("I/O error");
    const deps = dependencies({
      save: () => {
        throw new Error("save must not run when history is disabled");
      },
      purgeExpired: () => {
        throw error;
      },
    });

    const result = persistCompletedDictationHistory(false, deps);

    expect(result).toEqual({ record: transient, warning: HISTORY_RETENTION_WARNING });
    expect(deps.recordFailure).toHaveBeenCalledWith("history_retention", error);
  });

  it("does not let a stale renderer notification or diagnostics sink undo success", () => {
    const deps = dependencies({
      notifyChanged: () => {
        throw new Error("window destroyed");
      },
      recordFailure: () => {
        throw new Error("diagnostics unavailable");
      },
      purgeExpired: () => {
        throw new Error("disk error");
      },
    });

    expect(persistCompletedDictationHistory(true, deps)).toEqual({
      record: saved,
      warning: HISTORY_RETENTION_WARNING,
    });
  });
});

describe("main keeps the history tail outside the dictation failure path", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const completion = sliceBetween(
    main,
    "async function completeDictationFinal(input:",
    "function trustedSurfaceForEvent",
    "src/main.ts",
  );

  it("announces insertion before best-effort persistence and turns its result into a success warning", () => {
    expectPrecedes(
      completion,
      'setSession({ state: "success", sessionId, message: successMessage });',
      "persistCompletedDictationHistory(settings.keepHistory",
      "completeDictationFinal",
    );
    expect(completion).toContain("recordFailure: (event, error) => diagnostics.record({");
    expect(completion).toContain('stage: "lifecycle"');
    expect(completion).toContain("detail: normalizeDiagnosticCode(error)");
    expect(completion).toContain("if (history.warning)");
    expect(completion).toContain("message: history.warning");
  });
});
