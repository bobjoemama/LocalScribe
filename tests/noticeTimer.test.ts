import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  createNoticeTimer,
  noticeDurationMs,
  noticeFor,
  type NoticeTimerDependencies,
} from "../src/main/session/noticeTimer";
import { ERROR_NOTICE_DURATION_MS, SUCCESS_NOTICE_DURATION_MS } from "../src/shared/dictationErrors";
import { expectPrecedes, requireIndex, sliceBetween, sliceFollowing } from "./support/order";

/*
 * The wedge these tests exist for: main announces `success`, then writes the
 * transcript. If the write throws — SQLITE_FULL on a full disk, SQLITE_BUSY, a
 * disk I/O error — the caller-armed return to idle never runs, and the caller's
 * own catch cannot repair it, because entering `success` clears
 * `activeSessionId` and the catch is gated on it still matching.
 *
 * The session then sits in `success` until the app is restarted: the pill keeps
 * showing a finished dictation, and `assertModelSwitchAllowed` refuses every
 * model install, apply and remove. A failed history write becomes a permanently
 * unusable Models screen.
 *
 * The timer is injected, so these assert on effects rather than waiting.
 */

const SESSION = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

type Snapshot = { state: string; sessionId?: string; message?: string };

interface Harness {
  timer: ReturnType<typeof createNoticeTimer>;
  fire(): void;
  armCount(): number;
  cancelCount(): number;
  /** The duration the most recent arming asked for. */
  armedMs(): number | null;
  dismissed: Array<"error" | "success">;
  setLiveSession(next: Snapshot): void;
}

function harness(overrides: Partial<NoticeTimerDependencies> = {}): Harness {
  const dismissed: Array<"error" | "success"> = [];
  let live: Snapshot = { state: "idle" };
  let pending: (() => void) | null = null;
  let lastMs: number | null = null;
  let arms = 0;
  let cancels = 0;

  const timer = createNoticeTimer({
    setTimer: (callback, milliseconds) => {
      arms += 1;
      lastMs = milliseconds;
      pending = callback;
      return {
        cancel: () => {
          cancels += 1;
          pending = null;
        },
      };
    },
    currentSession: () => live as never,
    dismiss: (state) => dismissed.push(state),
    ...overrides,
  });

  return {
    timer,
    fire: () => {
      const callback = pending;
      expect(callback, "no notice timer was armed").not.toBeNull();
      pending = null;
      callback?.();
    },
    armCount: () => arms,
    cancelCount: () => cancels,
    armedMs: () => lastMs,
    dismissed,
    setLiveSession: (next) => {
      live = next;
    },
  };
}

describe("the session notice timer", () => {
  it("returns a completed dictation to idle", () => {
    const h = harness();
    h.timer.observe({ state: "success", sessionId: SESSION, message: "Inserted" });
    h.setLiveSession({ state: "success", sessionId: SESSION, message: "Inserted" });

    expect(h.dismissed).toEqual([]);
    h.fire();

    expect(h.dismissed).toEqual(["success"]);
  });

  it("returns a failed dictation to idle", () => {
    const h = harness();
    h.timer.observe({ state: "error", message: "Dictation could not be completed." });
    h.setLiveSession({ state: "error", message: "Dictation could not be completed." });
    h.fire();

    // Main uses the reported state to also cancel insertion for an error, which
    // a success must not do — it has already inserted.
    expect(h.dismissed).toEqual(["error"]);
  });

  /*
   * The defect itself. The timer must exist before the caller does anything
   * else, so that a throw on the very next line still leaves a way out.
   */
  it("arms during the transition, before any caller work can throw", () => {
    const h = harness();
    expect(h.armCount()).toBe(0);
    h.timer.observe({ state: "success", sessionId: SESSION });
    expect(h.armCount()).toBe(1);
  });

  it("still clears a success whose history write threw", () => {
    const h = harness();
    // The whole sequence main runs: announce, then a write that fails. Nothing
    // after the transition gets a chance to arm anything.
    h.timer.observe({ state: "success", sessionId: SESSION, message: "Inserted" });
    h.setLiveSession({ state: "success", sessionId: SESSION, message: "Inserted" });
    expect(() => {
      throw Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" });
    }).toThrow();

    h.fire();

    expect(h.dismissed).toEqual(["success"]);
  });

  it.each(["idle", "listening", "finalizing", "transcribing", "inserting"] as const)(
    "disarms when the session becomes %s",
    (state) => {
      const h = harness();
      h.timer.observe({ state: "success", sessionId: SESSION });
      h.timer.observe({ state, sessionId: SESSION });
      h.setLiveSession({ state, sessionId: SESSION });

      expect(h.cancelCount()).toBe(1);
      expect(h.dismissed).toEqual([]);
    },
  );

  it("does not arm for a state that is not a notice", () => {
    const h = harness();
    h.timer.observe({ state: "listening", sessionId: SESSION });
    h.timer.observe({ state: "transcribing", sessionId: SESSION });
    h.timer.observe({ state: "finalizing", sessionId: SESSION });

    expect(h.armCount()).toBe(0);
  });

  /*
   * The dangerous false positive: a timer armed for dictation A fires and
   * dismisses the notice belonging to dictation B.
   */
  it("never dismisses a different success than the one it was armed for", () => {
    const h = harness();
    h.timer.observe({ state: "success", sessionId: SESSION });
    h.setLiveSession({ state: "success", sessionId: OTHER });
    h.fire();

    expect(h.dismissed).toEqual([]);
  });

  it("never dismisses a different error than the one it was armed for", () => {
    const h = harness();
    h.timer.observe({ state: "error", message: "Microphone access is blocked." });
    // A second, different failure replaced it — that one owns its own timer.
    h.setLiveSession({ state: "error", message: "Dictation could not be completed." });
    h.fire();

    expect(h.dismissed).toEqual([]);
  });

  it("never lets a success timer dismiss an error", () => {
    const h = harness();
    h.timer.observe({ state: "success", sessionId: SESSION });
    // Same session id, different state: matching on the id alone would clear a
    // failure notice the user has not had time to read.
    h.setLiveSession({ state: "error", sessionId: SESSION, message: "Transcription failed." });
    h.fire();

    expect(h.dismissed).toEqual([]);
  });

  it("gives a second notice its own full duration", () => {
    const h = harness();
    h.timer.observe({ state: "success", sessionId: SESSION });
    h.timer.observe({ state: "idle" });
    h.timer.observe({ state: "success", sessionId: OTHER });
    h.setLiveSession({ state: "success", sessionId: OTHER });

    expect(h.armCount()).toBe(2);
    h.fire();
    expect(h.dismissed).toEqual(["success"]);
  });

  it("re-arms with the error duration when a success is replaced by a failure", () => {
    const h = harness();
    h.timer.observe({ state: "success", sessionId: SESSION });
    expect(h.armedMs()).toBe(SUCCESS_NOTICE_DURATION_MS);
    h.timer.observe({ state: "error", message: "Transcription failed." });

    // Inheriting the success timer would blank a failure message in 1.4 s.
    expect(h.armedMs()).toBe(ERROR_NOTICE_DURATION_MS);
    expect(h.cancelCount()).toBe(1);
  });

  it("can be disarmed for shutdown without firing", () => {
    const h = harness();
    h.timer.observe({ state: "error", message: "Transcription failed." });
    h.timer.cancel();

    expect(h.cancelCount()).toBe(1);
    expect(h.dismissed).toEqual([]);
  });

  it("survives a cancel with nothing armed", () => {
    const h = harness();
    expect(() => h.timer.cancel()).not.toThrow();
    expect(h.cancelCount()).toBe(0);
  });

  it("gives a failure long enough to be read, and a success much less", () => {
    // An error names something the user has to act on; a success is a receipt.
    expect(noticeDurationMs({ state: "error", message: undefined })).toBe(ERROR_NOTICE_DURATION_MS);
    expect(noticeDurationMs({ state: "success", sessionId: SESSION })).toBe(SUCCESS_NOTICE_DURATION_MS);
    expect(ERROR_NOTICE_DURATION_MS).toBeGreaterThan(SUCCESS_NOTICE_DURATION_MS);
    expect(ERROR_NOTICE_DURATION_MS).toBeGreaterThanOrEqual(5_000);
  });

  it("treats only success and error as notices", () => {
    expect(noticeFor({ state: "success", sessionId: SESSION })).not.toBeNull();
    expect(noticeFor({ state: "error", message: "x" })).not.toBeNull();
    for (const state of ["idle", "listening", "finalizing", "transcribing", "inserting"]) {
      expect(noticeFor({ state } as never), state).toBeNull();
    }
  });
});

/*
 * The module is only worth anything if `setSession` runs it and nothing else
 * arms a competing timer. A behaviour test on the module cannot see either.
 */
describe("main arms the notice timer", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const setSession = sliceBetween(main, "function setSession(", "function failSession(");

  it("observes every session transition inside setSession", () => {
    expect(setSession).toContain("noticeTimer.observe(session)");
  });

  it("observes after the snapshot is committed, not before", () => {
    expectPrecedes(setSession, "session = sessionSnapshotSchema.parse", "noticeTimer.observe(");
  });

  it("leaves no caller-armed return to idle behind", () => {
    // The bug was a `setTimeout(... "idle" ...)` at a call site. Any timer that
    // sets idle outside the notice timer can be skipped by a throw, which is
    // exactly the defect this module exists to make unreachable.
    expect(main).not.toMatch(/setTimeout\([^)]*state: "idle"/su);
    expect(main).not.toContain("successIdleTimer");
    expect(main).not.toContain("errorDismissTimer");
  });

  it("cancels insertion for an error dismissal and not for a success", () => {
    // `\n});` rather than `});`: the latter first appears mid-line, inside the
    // `setSession({ state: "idle" });` this test is looking for.
    const dismiss = sliceFollowing(main, "const noticeTimer = createNoticeTimer(", "\n});");
    expect(dismiss).toContain('if (state === "error") insertion.cancelSession();');
    expect(dismiss).toContain('setSession({ state: "idle" });');
  });

  it("disarms the notice timer during shutdown", () => {
    const shutdown = main.slice(requireIndex(main, "function beginShutdown(")).slice(0, 1_500);
    expect(shutdown).toContain("noticeTimer.cancel()");
    expectPrecedes(shutdown, "quitting = true;", "noticeTimer.cancel()");
  });

  it("keeps both session timers off the event loop", () => {
    // A referenced timer would hold the process open past the last window.
    const factory = sliceFollowing(main, "function unrefTimer(", "\n}");
    expect(factory).toContain("timer.unref()");
    expect(main).toContain("setTimer: unrefTimer");
  });
});
