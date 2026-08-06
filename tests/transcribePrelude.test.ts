import { describe, expect, it } from "vitest";

import { expectHappenedBefore } from "./support/order";

import {
  DictationCancelled,
  InactiveSession,
  discardAudio,
  prepareTranscription,
  type TranscribePreludeDependencies,
} from "../src/main/session/transcribePrelude";

/*
 * These are behaviour tests with fault injection, not source assertions.
 *
 * The prelude has produced three separate "the pill is stuck forever" defects,
 * and the previous round's fix for one of them introduced another: the catch
 * ran `await rm(...)` before `failSession`, so a cleanup failure skipped the
 * state reset entirely. A source test that greps for `failSession` cannot tell
 * the difference between the broken order and the correct one — only running it
 * with a rejecting `rm` can.
 *
 * Every case therefore asserts on recorded effects: what the session was told,
 * in what order, and which error the caller finally saw.
 */

const SESSION = "11111111-2222-4333-8444-555555555555";

interface Recorder {
  deps: TranscribePreludeDependencies;
  failures: unknown[];
  order: string[];
  events: Array<{ event: string; outcome: string; detail?: string }>;
  removed: string[];
  written: string[];
}

function harness(overrides: Partial<TranscribePreludeDependencies> & {
  admitAfterWrite?: boolean;
} = {}): Recorder {
  const failures: unknown[] = [];
  const order: string[] = [];
  const events: Array<{ event: string; outcome: string; detail?: string }> = [];
  const removed: string[] = [];
  const written: string[] = [];
  let writes = 0;

  const deps: TranscribePreludeDependencies = {
    parse: (raw) => raw as never,
    admits: (sessionId) => {
      if (sessionId !== SESSION) return false;
      // `admitAfterWrite: false` models a cancel landing during the WAV write.
      if (writes > 0 && overrides.admitAfterWrite === false) return false;
      return true;
    },
    isFinalizing: () => true,
    readSettings: () => ({ language: "en" }) as never,
    audioCacheRoot: () => "/tmp/localscribe-cache",
    newAudioPath: (root) => `${root}/audio.wav`,
    writeAudio: async (target) => {
      writes += 1;
      written.push(target);
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
    record: (event) => {
      events.push({ event: event.event, outcome: event.outcome, detail: event.detail });
      order.push(`record:${event.event}`);
    },
    errorCode: (error) => (error instanceof Error ? error.name : "unknown"),
    ...overrides,
  };
  return { deps, failures, order, events, removed, written };
}

function request(): unknown {
  return { sessionId: SESSION, durationMs: 1_000, wav: new ArrayBuffer(8) };
}

describe("the transcribe prelude never strands a session", () => {
  it("stages the audio and returns on the happy path", async () => {
    const h = harness();
    const prepared = await prepareTranscription(request(), h.deps);

    expect(prepared.audioPath).toBe("/tmp/localscribe-cache/audio.wav");
    expect(prepared.input.sessionId).toBe(SESSION);
    expect(h.failures).toHaveLength(0);
    expect(h.removed).toHaveLength(0);
  });

  it("fails the session when the payload is rejected", async () => {
    const h = harness({
      parse: () => {
        throw new Error("audio exceeds the maximum duration");
      },
    });

    await expect(prepareTranscription(request(), h.deps)).rejects.toThrow(/maximum duration/u);
    // Without this the renderer's swallowed rejection leaves "Finishing up" up
    // for the rest of the run.
    expect(h.failures).toHaveLength(1);
  });

  it("does not fail a session that is not finalizing when the payload is rejected", async () => {
    const h = harness({
      isFinalizing: () => false,
      parse: () => {
        throw new Error("bad payload");
      },
    });

    await expect(prepareTranscription(request(), h.deps)).rejects.toThrow(/bad payload/u);
    expect(h.failures).toHaveLength(0);
  });

  it("rejects audio from a session that is not the live dictation", async () => {
    const h = harness();
    await expect(
      prepareTranscription({ ...(request() as object), sessionId: "other" }, h.deps),
    ).rejects.toBeInstanceOf(InactiveSession);
    expect(h.written).toHaveLength(0);
  });

  it.each([
    ["unreadable settings", { readSettings: () => { throw new Error("db is locked"); } }],
    ["a missing audio cache root", { audioCacheRoot: () => null }],
    ["a failed WAV write", { writeAudio: async () => { throw new Error("ENOSPC"); } }],
  ])("fails the session when the prelude hits %s", async (_label, override) => {
    const h = harness(override as Partial<TranscribePreludeDependencies>);
    await expect(prepareTranscription(request(), h.deps)).rejects.toThrow();
    expect(h.failures).toHaveLength(1);
  });

  /*
   * THE REGRESSION. The catch used to read:
   *
   *   if (audioPath) await rm(audioPath, { force: true });
   *   if (activeSessionId === input.sessionId) failSession(error);
   *
   * `rm` with `force: true` swallows ENOENT but still rejects on EACCES,
   * EPERM, EIO and EBUSY. When it rejected, `failSession` was never reached and
   * the session stayed in "finalizing" forever — the exact class of defect the
   * prelude was written to eliminate.
   */
  it("fails the session even when cleanup itself throws", async () => {
    const h = harness({
      writeAudio: async () => {
        throw new Error("ENOSPC");
      },
      removeAudio: async () => {
        throw new Error("EIO");
      },
    });

    await expect(prepareTranscription(request(), h.deps)).rejects.toThrow(/ENOSPC/u);
    expect(h.failures).toHaveLength(1);
  });

  it("fails the session before attempting cleanup, not after", async () => {
    const h = harness({
      writeAudio: async () => {
        throw new Error("ENOSPC");
      },
    });

    await expect(prepareTranscription(request(), h.deps)).rejects.toThrow();
    // Ordering is the guarantee: cleanup must not be able to run first and
    // then prevent the reset by throwing.
    //
    // Via `expectHappenedBefore` rather than a raw index comparison, which
    // holds vacuously when `failSession` never ran at all — the very failure
    // this test exists to detect.
    expectHappenedBefore(h.order, "failSession", "remove");
  });

  it("reports the original failure, never the cleanup failure", async () => {
    const h = harness({
      writeAudio: async () => {
        throw new Error("ENOSPC");
      },
      removeAudio: async () => {
        throw new Error("EIO");
      },
    });

    // A user whose disk filled up must be told the disk filled up.
    await expect(prepareTranscription(request(), h.deps)).rejects.toThrow(/ENOSPC/u);
    expect(h.failures).toHaveLength(1);
    expect((h.failures[0] as Error).message).toBe("ENOSPC");
  });

  it("records a cleanup failure instead of swallowing it entirely", async () => {
    const h = harness({
      writeAudio: async () => {
        throw new Error("ENOSPC");
      },
      removeAudio: async () => {
        throw new Error("EIO");
      },
    });

    await expect(prepareTranscription(request(), h.deps)).rejects.toThrow();
    expect(h.events).toContainEqual(
      expect.objectContaining({ event: "temporary_audio_remove", outcome: "failed" }),
    );
  });

  it("treats a cancel that lands during the write as a cancellation", async () => {
    const h = harness({ admitAfterWrite: false });

    const error = await prepareTranscription(request(), h.deps).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(DictationCancelled);
    // A cancelled dictation is not a failure: the cancel handler already
    // returned the session to idle, and failing it would replace "idle" with
    // an error the user did not cause.
    expect(h.failures).toHaveLength(0);
    // The staged audio is still removed.
    expect(h.removed).toEqual(["/tmp/localscribe-cache/audio.wav"]);
  });

  it("still reports the cancellation when cleaning up the cancelled audio fails", async () => {
    const h = harness({
      admitAfterWrite: false,
      removeAudio: async () => {
        throw new Error("EIO");
      },
    });

    await expect(prepareTranscription(request(), h.deps)).rejects.toBeInstanceOf(DictationCancelled);
  });
});

describe("discardAudio is best effort", () => {
  it("resolves when the removal fails", async () => {
    const events: string[] = [];
    await expect(
      discardAudio("/tmp/x.wav", {
        removeAudio: async () => {
          throw new Error("EPERM");
        },
        record: (event) => events.push(event.event),
        errorCode: () => "EPERM",
      }),
    ).resolves.toBeUndefined();
    expect(events).toEqual(["temporary_audio_remove"]);
  });

  it("does nothing at all when there is no path", async () => {
    const events: string[] = [];
    await discardAudio(undefined, {
      removeAudio: async () => {
        throw new Error("should not be called");
      },
      record: (event) => events.push(event.event),
      errorCode: () => "x",
    });
    expect(events).toEqual([]);
  });

  it("stays silent when the removal succeeds", async () => {
    const events: string[] = [];
    await discardAudio("/tmp/x.wav", {
      removeAudio: async () => {},
      record: (event) => events.push(event.event),
      errorCode: () => "x",
    });
    expect(events).toEqual([]);
  });
});
