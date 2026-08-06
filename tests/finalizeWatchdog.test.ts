import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  FINALIZING_WATCHDOG_MS,
  createFinalizeWatchdog,
  type FinalizeWatchdogDependencies,
} from "../src/main/session/finalizeWatchdog";
import { expectPrecedes, requireIndex, sliceBetween } from "./support/order";

/*
 * The wedge these tests exist for: main enters `finalizing` and the renderer
 * never sends `session.transcribe` or `session.fail`. Nothing else in main can
 * leave that state, so the toggle accelerator, the hold key and both tray
 * entries silently stop working and every model operation is refused, until the
 * app is restarted. Three reachable paths produce it — a `stop()` that rejects
 * with a previous session's `RecorderCancelledError`, a pill that mounts into a
 * `finalizing` snapshot it has no branch for, and a renderer that dies
 * mid-encode — and a fourth (a history write that throws after the success
 * transition) has the same shape.
 *
 * The timer is injected, so these run instantly and assert on effects.
 */

const SESSION = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

interface Harness {
  watchdog: ReturnType<typeof createFinalizeWatchdog>;
  fire(): void;
  armCount(): number;
  cancelCount(): number;
  failures: Error[];
  events: Array<{ event: string; outcome: string; sessionId?: string }>;
  setLiveSession(next: { state: string; sessionId?: string }): void;
}

function harness(overrides: Partial<FinalizeWatchdogDependencies> = {}): Harness {
  const failures: Error[] = [];
  const events: Array<{ event: string; outcome: string; sessionId?: string }> = [];
  let live: { state: string; sessionId?: string } = { state: "idle" };
  let pending: (() => void) | null = null;
  let arms = 0;
  let cancels = 0;

  const watchdog = createFinalizeWatchdog({
    setTimer: (callback) => {
      arms += 1;
      pending = callback;
      return {
        cancel: () => {
          cancels += 1;
          pending = null;
        },
      };
    },
    currentSession: () => live as never,
    fail: (reason) => failures.push(reason),
    record: (event) => events.push({
      event: event.event,
      outcome: event.outcome,
      sessionId: event.sessionId,
    }),
    ...overrides,
  });

  return {
    watchdog,
    fire: () => {
      const callback = pending;
      expect(callback, "no watchdog timer was armed").not.toBeNull();
      pending = null;
      callback?.();
    },
    armCount: () => arms,
    cancelCount: () => cancels,
    failures,
    events,
    setLiveSession: (next) => {
      live = next;
    },
  };
}

describe("the finalizing watchdog", () => {
  it("fails a session the renderer never finished", () => {
    const h = harness();
    h.watchdog.observe({ state: "finalizing", sessionId: SESSION });
    h.setLiveSession({ state: "finalizing", sessionId: SESSION });

    expect(h.failures).toHaveLength(0);
    h.fire();

    expect(h.failures).toHaveLength(1);
    // The message reaches the pill, so the user learns the dictation is over
    // instead of pressing a shortcut that does nothing.
    expect(h.failures[0]?.message).toMatch(/could not be completed/iu);
  });

  it("records the timeout so a bug report can name it", () => {
    const h = harness();
    h.watchdog.observe({ state: "finalizing", sessionId: SESSION });
    h.setLiveSession({ state: "finalizing", sessionId: SESSION });
    h.fire();

    expect(h.events).toEqual([
      expect.objectContaining({
        event: "finalize_watchdog",
        outcome: "failed",
        sessionId: SESSION,
      }),
    ]);
  });

  it("does not fire for a dictation that completed normally", () => {
    const h = harness();
    h.watchdog.observe({ state: "finalizing", sessionId: SESSION });
    // The renderer sent the audio; main moved on.
    h.watchdog.observe({ state: "transcribing", sessionId: SESSION });

    expect(h.cancelCount()).toBe(1);
    expect(h.failures).toHaveLength(0);
  });

  it.each([
    "idle", "listening", "transcribing", "inserting", "success", "error",
  ] as const)(
    "disarms when the session becomes %s",
    (state) => {
      const h = harness();
      h.watchdog.observe({ state: "finalizing", sessionId: SESSION });
      h.watchdog.observe({ state, sessionId: SESSION });
      h.setLiveSession({ state, sessionId: SESSION });

      expect(h.cancelCount()).toBe(1);
      expect(h.failures).toHaveLength(0);
    },
  );

  /*
   * The dangerous false positive: a timer armed for dictation A fires while
   * dictation B is legitimately finalizing, and kills B.
   */
  it("never fails a different dictation than the one it was armed for", () => {
    const h = harness();
    h.watchdog.observe({ state: "finalizing", sessionId: SESSION });
    h.setLiveSession({ state: "finalizing", sessionId: OTHER });
    h.fire();

    expect(h.failures).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it("gives a second finalizing session its own full budget", () => {
    const h = harness();
    h.watchdog.observe({ state: "finalizing", sessionId: SESSION });
    h.watchdog.observe({ state: "idle" });
    h.watchdog.observe({ state: "finalizing", sessionId: OTHER });
    h.setLiveSession({ state: "finalizing", sessionId: OTHER });

    expect(h.armCount()).toBe(2);
    h.fire();
    expect(h.failures).toHaveLength(1);
  });

  it("does not arm at all for a state that can leave on its own", () => {
    const h = harness();
    h.watchdog.observe({ state: "transcribing", sessionId: SESSION });
    h.watchdog.observe({ state: "error", sessionId: SESSION });

    expect(h.armCount()).toBe(0);
  });

  it("can be disarmed for shutdown without firing", () => {
    const h = harness();
    h.watchdog.observe({ state: "finalizing", sessionId: SESSION });
    h.watchdog.cancel();

    expect(h.cancelCount()).toBe(1);
    expect(h.failures).toHaveLength(0);
  });

  it("waits far longer than any legitimate encode", () => {
    // Capture is capped at 600 s / 20 MB and encoding that is sub-second, so
    // this must never be the reason a slow machine loses a dictation.
    expect(FINALIZING_WATCHDOG_MS).toBeGreaterThanOrEqual(15_000);
  });
});

/*
 * The watchdog is only worth anything if `setSession` actually runs it, and a
 * behaviour test on the module cannot see that. Narrow source pin, same as the
 * one on the transcribe prelude.
 */
describe("main arms the watchdog", () => {
  const main = readFileSync("src/main.ts", "utf8");

  it("observes every session transition inside setSession", () => {
    const setSession = sliceBetween(main, "function setSession(", "function failSession(");
    expect(setSession).toContain("finalizeWatchdog.observe(session)");
  });

  it("observes after the snapshot is committed, not before", () => {
    const setSession = sliceBetween(main, "function setSession(", "function failSession(");
    expectPrecedes(setSession, "session = sessionSnapshotSchema.parse", "finalizeWatchdog.observe(");
  });

  it("disarms the watchdog during shutdown", () => {
    // `insertion.cancelSession()` appears earlier in the file too, so anchor on
    // the function and take the block, rather than on a marker that repeats.
    const shutdown = main.slice(requireIndex(main, "function beginShutdown(")).slice(0, 1_500);
    expect(shutdown).toContain("finalizeWatchdog.cancel()");
    expectPrecedes(shutdown, "quitting = true;", "finalizeWatchdog.cancel()");
  });
});
