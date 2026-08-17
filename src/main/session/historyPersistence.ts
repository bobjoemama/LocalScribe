import type { Transcription } from "../../shared/contracts";

/**
 * Final-result history is deliberately best effort.
 *
 * Text insertion (or copying) is the user-visible completion boundary. A full
 * disk, locked SQLite file, or failed retention sweep after that point must not
 * retroactively turn a completed dictation into a generic failure. Keeping
 * this small tail separate makes that ordering executable in tests instead of
 * relying on the surrounding IPC handlers to happen not to rethrow it.
 */

export const HISTORY_SAVE_WARNING = "Done; history not saved";
export const HISTORY_RETENTION_WARNING = "Done; history cleanup failed";

export type HistoryPersistenceFailure = "history_save" | "history_retention";

export interface HistoryPersistenceDependencies {
  /** Create the IPC result used when history is intentionally disabled or unavailable. */
  transientRecord: () => Transcription;
  /** Persist the completed transcription when the user has history enabled. */
  save: () => Transcription;
  /** Delete records outside the selected retention window. */
  purgeExpired: () => number;
  /** Tell history views to reload after a durable mutation. */
  notifyChanged: () => void;
  /** Record a redacted diagnostic without making the completed dictation fail. */
  recordFailure: (event: HistoryPersistenceFailure, error: unknown) => void;
}

export interface HistoryPersistenceResult {
  record: Transcription;
  warning?: typeof HISTORY_SAVE_WARNING | typeof HISTORY_RETENTION_WARNING;
}

function safelyNotify(deps: HistoryPersistenceDependencies): void {
  // A renderer may be closing while this runs. Its stale notification is not a
  // reason to turn an already-inserted dictation into an IPC rejection.
  try {
    deps.notifyChanged();
  } catch {
    // The next opened history view reads from SQLite, so this broadcast is only
    // an immediate refresh optimization.
  }
}

function safelyRecord(
  deps: HistoryPersistenceDependencies,
  event: HistoryPersistenceFailure,
  error: unknown,
): void {
  // Diagnostics are useful evidence, never a dependency of dictation success.
  try {
    deps.recordFailure(event, error);
  } catch {
    // Intentionally ignored: this is the same best-effort boundary as the
    // recorder's own I/O queue.
  }
}

/**
 * Persist the history tail after insertion/copy has already completed.
 *
 * Returns an in-memory transcription on a failed save so the public IPC
 * contract remains stable. The caller presents `warning` in the existing
 * success notice; it must not call `failSession` for either failure.
 */
export function persistCompletedDictationHistory(
  keepHistory: boolean,
  deps: HistoryPersistenceDependencies,
): HistoryPersistenceResult {
  let record: Transcription;

  if (keepHistory) {
    try {
      record = deps.save();
      safelyNotify(deps);
    } catch (error) {
      safelyRecord(deps, "history_save", error);
      return { record: deps.transientRecord(), warning: HISTORY_SAVE_WARNING };
    }
  } else {
    record = deps.transientRecord();
  }

  try {
    const purged = deps.purgeExpired();
    if (purged > 0) safelyNotify(deps);
  } catch (error) {
    safelyRecord(deps, "history_retention", error);
    return { record, warning: HISTORY_RETENTION_WARNING };
  }

  return { record };
}
