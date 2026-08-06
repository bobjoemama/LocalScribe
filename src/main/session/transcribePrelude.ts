import type { AppSettings, TranscribeAudioRequest } from "../../shared/contracts";

/**
 * Everything that happens between "the renderer handed us audio" and "the
 * session is officially transcribing".
 *
 * This is extracted from the IPC handler for one reason: the defects here are
 * all about *ordering and error handling*, and ordering cannot be tested by
 * reading source text. Three separate stuck-session bugs lived in this stretch
 * of code, and each was introduced by a change that looked obviously correct:
 *
 *  - a rejected payload threw before the state machine was told, leaving the
 *    pill on "Finishing up" forever, because the renderer deliberately
 *    swallows this channel's rejection;
 *  - the catch that fixed that ran `await rm(...)` *before* `failSession`, so a
 *    cleanup failure skipped the state reset and reintroduced the same stuck
 *    session through a different door;
 *  - a cancel landing during the multi-megabyte WAV write re-entered
 *    "transcribing" for a dictation that was already gone.
 *
 * With the dependencies injected, a test can make `writeAudio` or `removeAudio`
 * reject on demand and assert what the session actually did, which is the only
 * way to hold these guarantees.
 */

export interface TranscribePreludeDependencies {
  /** Validates the raw IPC payload. Throws on a malformed or over-large one. */
  parse: (raw: unknown) => TranscribeAudioRequest;
  /** Whether this session id is still the live dictation. */
  admits: (sessionId: string) => boolean;
  /** True while the session snapshot is in "finalizing". */
  isFinalizing: () => boolean;
  readSettings: () => AppSettings;
  /** Null until the private audio cache has been created. */
  audioCacheRoot: () => string | null;
  /** A fresh unique path inside the cache root. */
  newAudioPath: (cacheRoot: string) => string;
  writeAudio: (audioPath: string, wav: ArrayBuffer) => Promise<void>;
  /** Best-effort delete. May reject; the prelude must survive that. */
  removeAudio: (audioPath: string) => Promise<void>;
  failSession: (error: unknown) => void;
  record: (event: {
    stage: "ipc" | "session" | "cleanup";
    event: string;
    outcome: "ok" | "failed" | "cancelled";
    sessionId?: string;
    detail?: string;
  }) => void;
  /** Reduces a thrown value to a non-identifying code for diagnostics. */
  errorCode: (error: unknown) => string;
}

export interface PreparedTranscription {
  input: TranscribeAudioRequest;
  settings: AppSettings;
  cacheRoot: string;
  audioPath: string;
}

/**
 * Delete a temporary WAV without letting the deletion become the outcome.
 *
 * `rm(path, { force: true })` swallows ENOENT but still rejects on EACCES,
 * EPERM, EIO, and EBUSY. Cleanup here is genuinely best-effort — the cache
 * lives in the OS temp directory, is wiped at the next start, and is removed
 * wholesale on quit — so a file left behind is strictly better than a
 * misreported dictation. The failure is recorded rather than raised.
 */
export async function discardAudio(
  audioPath: string | undefined,
  deps: Pick<TranscribePreludeDependencies, "removeAudio" | "record" | "errorCode">,
  sessionId?: string,
): Promise<void> {
  if (!audioPath) return;
  try {
    await deps.removeAudio(audioPath);
  } catch (error) {
    deps.record({
      stage: "cleanup",
      event: "temporary_audio_remove",
      outcome: "failed",
      sessionId,
      detail: deps.errorCode(error),
    });
  }
}

/** Raised when the dictation was cancelled while its audio was being written. */
export class DictationCancelled extends Error {
  constructor() {
    super("Dictation was cancelled");
    this.name = "DictationCancelled";
  }
}

/** Raised when audio arrives for a session that is not the live dictation. */
export class InactiveSession extends Error {
  constructor() {
    super("Rejected audio from an inactive dictation session");
    this.name = "InactiveSession";
  }
}

/**
 * Validate, admit, and stage the audio. Resolves only when the caller may
 * safely transition the session to "transcribing".
 *
 * Guarantees, each of which has a test:
 *  1. Every rejection path leaves the session out of "finalizing" — `failSession`
 *     runs whenever this session is still the active one.
 *  2. `failSession` runs *before* any cleanup, so cleanup can never prevent it.
 *  3. A cleanup failure is never the error the caller sees.
 *  4. A cancel that lands during the write does not re-enter "transcribing",
 *     and does not report a generic failure.
 */
export async function prepareTranscription(
  raw: unknown,
  deps: TranscribePreludeDependencies,
): Promise<PreparedTranscription> {
  let input: TranscribeAudioRequest;
  try {
    input = deps.parse(raw);
  } catch (error) {
    // No session id yet, so fall back to the snapshot's own state.
    if (deps.isFinalizing()) deps.failSession(error);
    deps.record({
      stage: "ipc",
      event: "transcribe_payload",
      outcome: "failed",
      detail: deps.errorCode(error),
    });
    throw error;
  }

  if (!deps.admits(input.sessionId)) throw new InactiveSession();

  let audioPath: string | undefined;
  try {
    const settings = deps.readSettings();
    const cacheRoot = deps.audioCacheRoot();
    if (!cacheRoot) throw new Error("Private audio storage is not ready.");
    audioPath = deps.newAudioPath(cacheRoot);
    await deps.writeAudio(audioPath, input.wav);

    /*
     * Cancel is a separate handler and can land while that write is in flight —
     * several megabytes for a multi-minute dictation. It clears the active
     * session and returns to idle, but it cannot unwind this call, so
     * transitioning unconditionally re-entered "transcribing" for a dictation
     * the user had already cancelled, with nothing left to move it out again.
     */
    if (!deps.admits(input.sessionId)) {
      deps.record({
        stage: "session",
        event: "transcribe_admission",
        outcome: "cancelled",
        sessionId: input.sessionId,
      });
      await discardAudio(audioPath, deps, input.sessionId);
      throw new DictationCancelled();
    }
    return { input, settings, cacheRoot, audioPath };
  } catch (error) {
    if (error instanceof DictationCancelled) throw error;
    /*
     * `failSession` first and unconditionally: it is synchronous and cannot
     * throw, so nothing after it can stop the session leaving "finalizing".
     * The cleanup that used to run first could, and did.
     */
    if (deps.admits(input.sessionId)) deps.failSession(error);
    deps.record({
      stage: "ipc",
      event: "transcribe_prelude",
      outcome: "failed",
      sessionId: input.sessionId,
      detail: deps.errorCode(error),
    });
    await discardAudio(audioPath, deps, input.sessionId);
    throw error;
  }
}
