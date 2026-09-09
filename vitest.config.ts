import { defineConfig } from "vitest/config";

/*
 * The suite ran on vitest's defaults with no config file at all. That was
 * survivable until a test wedged: two fork workers were found spinning at 100%
 * of a core each with 24 hours of CPU apiece, orphaned by a parent run that had
 * long since exited.
 *
 * The timeouts below are ceilings for detecting a hang, not targets. The whole
 * suite completes in about four seconds, so every value here is far above any
 * legitimate test and exists only so that a wedged one fails loudly instead of
 * running until someone notices.
 */
export default defineConfig({
  test: {
    // Generated native dependency checkouts contain their own test suites.
    include: ["tests/**/*.test.{ts,tsx,mts,mjs}"],
    /*
     * Generous relative to the real distribution (the slowest tests here are
     * packaged-artifact and SBOM checks measured in hundreds of milliseconds),
     * deliberately low relative to "forever".
     */
    testTimeout: 15_000,
    hookTimeout: 15_000,
    /*
     * A worker that will not come down after its tests finish is the exact
     * shape of the original incident, so bound teardown too.
     */
    teardownTimeout: 10_000,
    setupFiles: ["tests/support/orphanWatchdog.ts"],
  },
});
