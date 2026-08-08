import { afterEach, describe, expect, it, vi } from "vitest";

import vitestConfig from "../vitest.config";

/*
 * The suite had no config file, so a wedged test ran until a human noticed —
 * twice, for 24 hours of CPU each. These assert that the two protections added
 * afterwards are still there and still bounded, and that the watchdog itself
 * cannot become the thing that hangs a worker.
 */

/* Far above the ~4s the whole suite takes; far below "unattended forever". */
const CEILING_MS = 60_000;

interface TimeoutConfig {
  test?: {
    testTimeout?: number;
    hookTimeout?: number;
    teardownTimeout?: number;
    setupFiles?: string | string[];
  };
}

function testOptions(): NonNullable<TimeoutConfig["test"]> {
  const options = (vitestConfig as TimeoutConfig).test;
  if (!options) throw new Error("vitest.config.ts no longer defines a `test` block");
  return options;
}

describe("vitest run bounds", () => {
  it("bounds every timeout that can hide a hang", () => {
    const { testTimeout, hookTimeout, teardownTimeout } = testOptions();
    for (const [label, value] of Object.entries({
      testTimeout, hookTimeout, teardownTimeout,
    })) {
      /*
       * `toBeLessThanOrEqual` alone would pass for `undefined` in a loose
       * comparison, and passing on a missing value is the failure this guards.
       */
      expect(typeof value, `${label} must be configured`).toBe("number");
      expect(Number.isFinite(value), `${label} must be finite`).toBe(true);
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(CEILING_MS);
    }
  });

  it("registers the orphan watchdog as a setup file", () => {
    const { setupFiles } = testOptions();
    const files = typeof setupFiles === "string" ? [setupFiles] : setupFiles ?? [];
    expect(files.some((file) => file.includes("orphanWatchdog"))).toBe(true);
  });
});

describe("orphan watchdog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  /*
   * An interval that is not unref'd would keep every worker alive after its
   * tests finished — turning the fix into the very problem it was written to
   * prevent. Observing the real `setInterval` call is the only way to see it.
   */
  it("arms an unref'd interval so it can never hold a worker open", async () => {
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
      ..._args: unknown[]
    ) => ({ unref }) as unknown as NodeJS.Timeout) as typeof setInterval);

    vi.resetModules();
    await import("./support/orphanWatchdog.js");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
    /* A watchdog that polled every few milliseconds would cost more than it saves. */
    expect(spy.mock.calls[0]![1]).toBeGreaterThanOrEqual(1_000);
  });

  /*
   * A worker launched straight from a shell can legitimately have init as its
   * parent. Arming there would make it kill itself for no reason.
   */
  it("does not arm when it was already parentless at startup", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "ppid");
    Object.defineProperty(process, "ppid", { value: 1, configurable: true });
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      vi.resetModules();
      await import("./support/orphanWatchdog.js");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(process, "ppid", original);
    }
    expect(process.ppid).not.toBe(1);
  });
});
