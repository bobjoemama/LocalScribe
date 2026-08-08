/*
 * Two vitest fork workers were once found spinning at 100% of a core each,
 * 24 hours of CPU apiece, long after the run that started them was gone. A
 * child process does not die when its parent does: the workers were reparented
 * and kept running forever.
 *
 * This exits a worker that has outlived the run it belongs to. On macOS and
 * Linux an orphan is reparented to init, so `process.ppid` becoming 1 is the
 * signal. The timer is unref'd, so it never keeps an otherwise-finished worker
 * alive, and the interval is long enough that the check costs nothing.
 *
 * Scope, stated honestly: this cannot interrupt a *synchronous* infinite loop,
 * because such a loop never yields to the event loop and no in-process timer of
 * any kind will fire. Nothing running inside the process can. The protection
 * against that specific failure is the bounded, cycle-safe iteration in
 * `src/shared/diagnosticsLog.ts` (the loop that caused the original incident)
 * together with `testTimeout`, which catches the far more common asynchronous
 * hang. This watchdog covers the remaining case: a worker still alive after its
 * parent is gone.
 */
const CHECK_INTERVAL_MS = 5_000;

/*
 * Captured once at startup. A worker started directly from a shell (not by the
 * vitest parent) could legitimately have ppid 1, and must not shoot itself.
 */
const startingParentPid = process.ppid;

if (startingParentPid !== 1) {
  const timer = setInterval(() => {
    if (process.ppid === startingParentPid) return;
    process.stderr.write(
      `orphan watchdog: parent ${startingParentPid} is gone (ppid is now ` +
      `${process.ppid}); exiting rather than running unattended\n`,
    );
    process.exit(1);
  }, CHECK_INTERVAL_MS);
  timer.unref();
}

export {};
