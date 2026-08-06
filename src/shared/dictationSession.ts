import type { SessionState } from "./contracts";

/**
 * Whether recorded audio may still be admitted for transcription.
 *
 * Main must ask this twice for the same dictation. The first check happens when
 * the renderer's `session.transcribe` call arrives. The second happens after
 * the WAV has been written to the private audio cache — several megabytes for a
 * multi-minute dictation, and `session.cancel` is a separate IPC handler that
 * can land during exactly that await.
 *
 * Cancel clears `activeSessionId` and returns the session to idle, but it
 * cannot unwind the transcribe call already in flight. Without the second
 * check, main transitioned the session back into "transcribing" for a dictation
 * the user had already cancelled, and nothing moved it out again — the later
 * active-session assertion throws, but main only fails the session while
 * `activeSessionId` still matches, which by then it does not. The pill stayed
 * on "Transcribing locally" for the rest of the run.
 *
 * "accept" requires all three facts to agree: the session the renderer named is
 * the active one, main still believes that session is finalizing, and the
 * snapshot is describing that same session.
 */
export function transcribeAudioAdmission(input: {
  readonly activeSessionId: string | null;
  readonly sessionState: SessionState;
  readonly snapshotSessionId: string | undefined;
  readonly sessionId: string;
}): "accept" | "cancelled" {
  if (input.activeSessionId !== input.sessionId) return "cancelled";
  if (input.sessionState !== "finalizing") return "cancelled";
  if (input.snapshotSessionId !== input.sessionId) return "cancelled";
  return "accept";
}
