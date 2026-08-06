import type { DiagnosticEvent } from "../../shared/diagnosticsLog";
import type { SessionSnapshot } from "../../shared/contracts";

/*
 * `finalizing` is the one dictation state with no way out of its own.
 *
 * Every other non-idle state is left by something main controls: `transcribing`
 * ends when the worker returns or throws, `inserting` ends when insertion
 * resolves, `error` ends on a timer main arms itself. `finalizing` ends only if
 * the renderer sends `session.transcribe` or `session.fail` — and there are
 * reachable paths where it sends neither:
 *
 *   - `recorder.stop()` rejects with a *previous* session's
 *     `RecorderCancelledError`, and the pill's handler returns silently for
 *     that error type (src/renderer/pill/Pill.tsx).
 *   - the pill mounts and recovers a `finalizing` snapshot it has no transition
 *     branch for, because it never saw the `listening` that preceded it.
 *   - the renderer process is killed, reloaded, or wedged mid-encode.
 *
 * The consequence is the same in all three and it is severe out of proportion
 * to the cause: `beginListening` returns early for any state that is not
 * idle/success/error, so the toggle accelerator, the hold key and both tray
 * entries silently stop working, and every model install/apply/remove is
 * refused with "Finish or cancel the active dictation…". Until the app is
 * restarted. The user's report is "my shortcut does nothing".
 *
 * This bounds it. Nothing here decides that a dictation failed — it decides
 * that main has waited long enough for a renderer that is not coming back, and
 * hands the session to the same failure path any other stall would take.
 */

/**
 * How long a renderer may hold the session in `finalizing`.
 *
 * Finalizing covers stopping the recorder and encoding the captured audio to
 * WAV. The capture ceiling is 600 s / 20 MB, and encoding that much audio is a
 * sub-second operation, so this is generous by more than an order of magnitude:
 * it must never fire on a slow machine, only on a renderer that has stopped
 * making progress at all.
 */
export const FINALIZING_WATCHDOG_MS = 30_000;

export interface WatchdogTimer {
  cancel(): void;
}

export interface FinalizeWatchdogDependencies {
  /** Arms a timer; the returned handle must cancel it. */
  setTimer(callback: () => void, milliseconds: number): WatchdogTimer;
  /** The live session at the moment the timer fires, not when it was armed. */
  currentSession(): Pick<SessionSnapshot, "state" | "sessionId">;
  /** Takes the session out of `finalizing` the way any other stall would. */
  fail(reason: Error): void;
  record(event: Omit<DiagnosticEvent, "at">): void;
  timeoutMs?: number;
}

export interface FinalizeWatchdog {
  /** Call on every session transition, including into and out of finalizing. */
  observe(snapshot: Pick<SessionSnapshot, "state" | "sessionId">): void;
  /** Disarm without firing — used on shutdown. */
  cancel(): void;
}

export function createFinalizeWatchdog(deps: FinalizeWatchdogDependencies): FinalizeWatchdog {
  const timeoutMs = deps.timeoutMs ?? FINALIZING_WATCHDOG_MS;
  let armed: WatchdogTimer | null = null;

  const cancel = (): void => {
    armed?.cancel();
    armed = null;
  };

  return {
    cancel,
    observe(snapshot) {
      /*
       * Re-arming unconditionally is the point: a second `finalizing` for a new
       * session must get its own full budget, and any other state must clear a
       * timer armed for a dictation that has already moved on.
       */
      cancel();
      if (snapshot.state !== "finalizing") return;

      const watchedSessionId = snapshot.sessionId;
      armed = deps.setTimer(() => {
        armed = null;
        const live = deps.currentSession();
        /*
         * The session may have moved on between the timer firing and this
         * callback running, and a *different* dictation may now be finalizing
         * legitimately. Only fail the exact one this timer was armed for.
         */
        if (live.state !== "finalizing" || live.sessionId !== watchedSessionId) return;
        deps.record({
          stage: "session",
          event: "finalize_watchdog",
          outcome: "failed",
          sessionId: watchedSessionId,
          durationMs: timeoutMs,
        });
        deps.fail(new Error("Dictation could not be completed. Try again."));
      }, timeoutMs);
    },
  };
}
