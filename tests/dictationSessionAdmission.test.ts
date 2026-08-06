import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { transcribeAudioAdmission } from "../src/shared/dictationSession";
import {
  DictationCancelled,
  prepareTranscription,
  type TranscribePreludeDependencies,
} from "../src/main/session/transcribePrelude";
import { expectHappenedBefore, expectPrecedes, sliceBetween } from "./support/order";

const SESSION = "9a1f2c3d-0000-4000-8000-000000000001";
const OTHER = "9a1f2c3d-0000-4000-8000-000000000002";

const finalizing = {
  activeSessionId: SESSION,
  sessionState: "finalizing" as const,
  snapshotSessionId: SESSION,
  sessionId: SESSION,
};

describe("transcribe audio admission", () => {
  it("accepts audio for the session main is finalizing", () => {
    expect(transcribeAudioAdmission(finalizing)).toBe("accept");
  });

  /*
   * The defect: cancel lands while the WAV is being written, so by the time
   * main re-checks, `activeSessionId` is null. Admitting here re-entered
   * "transcribing" for a cancelled dictation, and nothing ever moved it out.
   */
  it("rejects audio once cancel has cleared the active session", () => {
    expect(transcribeAudioAdmission({ ...finalizing, activeSessionId: null })).toBe("cancelled");
  });

  it("rejects audio once cancel has returned the session to idle", () => {
    expect(transcribeAudioAdmission({ ...finalizing, sessionState: "idle" })).toBe("cancelled");
  });

  it("rejects audio for a session that is not the active one", () => {
    expect(transcribeAudioAdmission({ ...finalizing, activeSessionId: OTHER })).toBe("cancelled");
  });

  it("rejects audio when the snapshot describes a different session", () => {
    expect(transcribeAudioAdmission({ ...finalizing, snapshotSessionId: OTHER })).toBe("cancelled");
  });

  it("rejects audio when the snapshot carries no session at all", () => {
    expect(transcribeAudioAdmission({ ...finalizing, snapshotSessionId: undefined })).toBe("cancelled");
  });

  it.each(["idle", "listening", "transcribing", "inserting", "success", "error"] as const)(
    "rejects audio while the session is %s rather than finalizing",
    (sessionState) => {
      expect(transcribeAudioAdmission({ ...finalizing, sessionState })).toBe("cancelled");
    },
  );
});

/*
 * These three cases used to read `src/main.ts` and assert on the substrings of
 * an inline handler — `await writeFile(audioPath`, `} catch (error) {`, the
 * relative offsets of two `if (!admits())` guards. That whole stretch now lives
 * in `prepareTranscription`, so the assertions were pinning text that no longer
 * exists, and they could never have detected the ordering regression the module
 * actually shipped with (cleanup running before `failSession`) because both
 * orderings contain the same substrings.
 *
 * The guarantees are re-stated below as effects of running the real code, and
 * the one thing a behaviour test on the module genuinely cannot see — that main
 * still delegates to it — is pinned separately and narrowly.
 */
describe("staging audio for transcription", () => {
  const SESSION_UUID = "11111111-2222-4333-8444-555555555555";

  function stage(overrides: Partial<TranscribePreludeDependencies> = {}) {
    const order: string[] = [];
    const failures: unknown[] = [];
    const removed: string[] = [];
    let writes = 0;
    const deps: TranscribePreludeDependencies = {
      parse: (raw) => raw as never,
      admits: (sessionId) => sessionId === SESSION_UUID,
      isFinalizing: () => true,
      readSettings: () => ({ language: "en" }) as never,
      audioCacheRoot: () => "/tmp/cache",
      newAudioPath: (root) => `${root}/audio.wav`,
      writeAudio: async () => {
        writes += 1;
        order.push("write");
      },
      removeAudio: async (target) => {
        removed.push(target);
        order.push("remove");
      },
      failSession: (error) => {
        failures.push(error);
        order.push("failSession");
      },
      record: () => undefined,
      errorCode: () => "code",
      ...overrides,
    };
    return {
      deps,
      order,
      failures,
      removed,
      writeCount: () => writes,
      run: () => prepareTranscription(
        { sessionId: SESSION_UUID, durationMs: 1_000, wav: new ArrayBuffer(8) },
        deps,
      ),
    };
  }

  /*
   * The re-check has to happen after the WAV write, not only before it — that
   * await is the window cancel races. Admitting late re-entered "transcribing"
   * for a dictation the user had already cancelled, and nothing moved it out.
   */
  it("re-checks admission after writing the WAV and removes the orphaned file", async () => {
    let admitted = 0;
    const staged = stage({
      admits: () => {
        admitted += 1;
        // Accept the pre-write check; cancel lands while the file is written.
        return admitted === 1;
      },
    });

    await expect(staged.run()).rejects.toBeInstanceOf(DictationCancelled);
    expect(admitted).toBe(2);
    expect(staged.writeCount()).toBe(1);
    // Order, not just presence: the second check must follow the write.
    expectHappenedBefore(staged.order, "write", "remove");
    expect(staged.removed).toEqual(["/tmp/cache/audio.wav"]);
    // A cancel is not a failure — the cancel handler already reset the session.
    expect(staged.failures).toHaveLength(0);
  });

  /*
   * A failed write left the session pinned in "finalizing" with no error
   * surfaced, because the cleanup that follows starts after the transition.
   */
  it("fails the session when the WAV write itself throws", async () => {
    const staged = stage({
      writeAudio: async () => {
        throw new Error("ENOSPC");
      },
    });

    await expect(staged.run()).rejects.toThrow(/ENOSPC/u);
    expect(staged.failures).toHaveLength(1);
    expect((staged.failures[0] as Error).message).toBe("ENOSPC");
    expect(staged.removed).toEqual(["/tmp/cache/audio.wav"]);
  });

  /*
   * The write was not the only uncovered step. Reading settings, resolving the
   * audio cache root, and parsing the payload all run before the "transcribing"
   * transition, and the renderer swallows this channel's rejection by design, so
   * a throw in any of them stranded the pill on "Finishing up" with no error
   * anywhere.
   */
  it.each([
    ["the payload parse", { parse: () => { throw new Error("payload rejected"); } }],
    ["reading settings", { readSettings: () => { throw new Error("db is locked"); } }],
    ["resolving the audio cache root", { audioCacheRoot: () => null }],
    ["writing the WAV", { writeAudio: async () => { throw new Error("EIO"); } }],
  ])("fails the session when %s throws", async (_step, override) => {
    const staged = stage(override as Partial<TranscribePreludeDependencies>);

    await expect(staged.run()).rejects.toThrow();
    expect(staged.failures).toHaveLength(1);
  });

  it("leaves a session that is no longer finalizing alone", async () => {
    // A stale reply for a dictation that already ended must not overwrite
    // whatever state the user is in now.
    const staged = stage({
      isFinalizing: () => false,
      parse: () => {
        throw new Error("payload rejected");
      },
    });

    await expect(staged.run()).rejects.toThrow(/payload rejected/u);
    expect(staged.failures).toHaveLength(0);
  });
});

/*
 * Behaviour tests on the module prove the module is correct; they say nothing
 * about whether main still calls it. This is the one assertion that has to read
 * source, so it is kept to exactly that question.
 */
describe("main delegates the prelude", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const handler = sliceBetween(main, "handle(IPC.sessionTranscribe", "handle(IPC.historyList");

  it("stages the audio through prepareTranscription before entering transcribing", () => {
    expectPrecedes(handler, "await prepareTranscription(", 'state: "transcribing"');
  });

  it("does not write the WAV inline any more", () => {
    // Two copies of this logic is how the ordering guarantees drift apart.
    expect(handler).not.toContain("await writeFile(audioPath");
  });
});
