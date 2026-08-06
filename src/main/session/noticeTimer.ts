import type { SessionSnapshot } from "../../shared/contracts";
import { ERROR_NOTICE_DURATION_MS, SUCCESS_NOTICE_DURATION_MS } from "../../shared/dictationErrors";

/*
 * `success` and `error` are notices, not states the user acts on: the pill
 * shows what just happened and then has to go back to idle by itself.
 *
 * Both returns used to be armed by whichever caller produced the notice, and
 * the success one was armed *after* the transcript had already been written to
 * the database:
 *
 *     setSession({ state: "success", ... });
 *     database.saveTranscription(...);          // SQLITE_FULL, SQLITE_BUSY, I/O
 *     purgeExpiredTranscriptions(...);
 *     setTimeout(() => setSession({ state: "idle" }), 1_400);
 *
 * A throw anywhere in the middle skips the timer, and the caller's own catch
 * cannot repair it — entering `success` clears `activeSessionId`, and that
 * catch is gated on it still matching. The session then sits in `success`
 * forever. That is worse than the failed write it came from: the pill keeps
 * showing a finished dictation, and `assertModelSwitchAllowed` refuses every
 * model install, apply and remove ("Finish or cancel the active dictation…")
 * until the app restarts or another dictation happens to succeed.
 *
 * Arming from the transition itself is what makes that unreachable. A notice
 * cannot be entered without also scheduling its own way out, so no ordering
 * mistake in any present or future caller can strand the session.
 */

export interface NoticeTimerHandle {
  cancel(): void;
}

/**
 * The part of a notice that identifies *which* one it is.
 *
 * A timer must only dismiss the notice it was armed for. Errors are told apart
 * by message because consecutive failures share no session id — `failSession`
 * can be reached before one is assigned — and successes by session id because
 * two dictations can produce identical text.
 */
type Notice =
  | { state: "error"; message: string | undefined }
  | { state: "success"; sessionId: string | undefined };

export function noticeFor(snapshot: Pick<SessionSnapshot, "state" | "message" | "sessionId">): Notice | null {
  if (snapshot.state === "error") return { state: "error", message: snapshot.message };
  if (snapshot.state === "success") return { state: "success", sessionId: snapshot.sessionId };
  return null;
}

function sameNotice(armed: Notice, live: Notice | null): boolean {
  if (live === null) return false;
  if (armed.state === "error") return live.state === "error" && armed.message === live.message;
  return live.state === "success" && armed.sessionId === live.sessionId;
}

export function noticeDurationMs(notice: Notice): number {
  return notice.state === "error" ? ERROR_NOTICE_DURATION_MS : SUCCESS_NOTICE_DURATION_MS;
}

export interface NoticeTimerDependencies {
  /** Arms a timer; the returned handle must cancel it. */
  setTimer(callback: () => void, milliseconds: number): NoticeTimerHandle;
  /** The live session at the moment the timer fires, not when it was armed. */
  currentSession(): Pick<SessionSnapshot, "state" | "message" | "sessionId">;
  /** Returns the session to idle, and for an error also cancels pending insertion. */
  dismiss(state: "error" | "success"): void;
}

export interface NoticeTimer {
  /** Call on every session transition, including out of a notice. */
  observe(snapshot: Pick<SessionSnapshot, "state" | "message" | "sessionId">): void;
  /** Disarm without firing — used on shutdown. */
  cancel(): void;
}

export function createNoticeTimer(deps: NoticeTimerDependencies): NoticeTimer {
  let armed: NoticeTimerHandle | null = null;

  const cancel = (): void => {
    armed?.cancel();
    armed = null;
  };

  return {
    cancel,
    observe(snapshot) {
      /*
       * Unconditional re-arming is the point: a second notice must get its own
       * full duration, and any other state must clear a timer armed for a
       * dictation that has already moved on.
       */
      cancel();
      const notice = noticeFor(snapshot);
      if (notice === null) return;

      armed = deps.setTimer(() => {
        armed = null;
        // The session can move on between the timer firing and this callback
        // running, and a *different* notice may now be showing legitimately.
        if (!sameNotice(notice, noticeFor(deps.currentSession()))) return;
        deps.dismiss(notice.state);
      }, noticeDurationMs(notice));
    },
  };
}
