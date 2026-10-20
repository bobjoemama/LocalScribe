import { randomUUID } from "node:crypto";
import { updatePreparedSchema } from "../../shared/appUpdates";

export interface UpdateEditor {
  id: number;
  prepare(requestId: string): void;
  cancel(requestId: string): void;
  onUnavailable(cancel: () => void): () => void;
}

export const UPDATE_PREPARATION_TIMEOUT_MS = 60_000;
export const UPDATE_PREPARATION_CANCELLED = "Save or close pending work in Settings and Notes before choosing Restart to update again.";

/** Holds admission through retirement; persistence stays live while editors drain. */
export function createUpdateAdmission() {
  let attempt: {
    requestId: string;
    editors: UpdateEditor[];
    pending: Set<number>;
    retiring: boolean;
    cleanups: Array<() => void>;
    resolve(): void;
    reject(error: Error): void;
  } | undefined;

  const cancel = () => {
    const current = attempt;
    if (!current || current.retiring) return;
    attempt = undefined;
    for (const cleanup of current.cleanups) cleanup();
    for (const editor of current.editors) {
      try { editor.cancel(current.requestId); } catch { /* A failed renderer cannot receive release. */ }
    }
    current.reject(new Error(UPDATE_PREPARATION_CANCELLED));
  };

  return {
    get isPreparing(): boolean { return attempt !== undefined; },
    prepare(editors: UpdateEditor[]): Promise<void> {
      if (attempt) return Promise.reject(new Error("LocalScribe is busy preparing an update."));
      return new Promise<void>((resolve, reject) => {
        const current = { requestId: randomUUID(), editors, pending: new Set(editors.map(editor => editor.id)), retiring: false,
          cleanups: [] as Array<() => void>, resolve, reject };
        attempt = current;
        const cancelCurrent = () => { if (attempt === current) cancel(); };
        const timeout = setTimeout(cancelCurrent, UPDATE_PREPARATION_TIMEOUT_MS);
        current.cleanups.push(() => clearTimeout(timeout));
        try {
          for (const editor of editors) {
            current.cleanups.push(editor.onUnavailable(cancelCurrent));
            if (attempt !== current) return;
          }
          for (const editor of editors) {
            editor.prepare(current.requestId);
            if (attempt !== current) return;
          }
          if (current.pending.size === 0) {
            for (const cleanup of current.cleanups.splice(0)) cleanup();
            resolve();
          }
        } catch { cancel(); }
      });
    },
    retire(): boolean {
      const current = attempt;
      if (!current || current.pending.size !== 0 || current.retiring) return false;
      // Persistence is about to close. Cancellation must never reopen editors
      // after this point, including an emitter callback already in dispatch.
      current.retiring = true;
      for (const cleanup of current.cleanups.splice(0)) cleanup();
      return true;
    },
    acknowledge(editorId: number, payload: unknown): void {
      const parsed = updatePreparedSchema.safeParse(payload);
      const current = attempt;
      if (!parsed.success || !current || current.retiring || parsed.data.requestId !== current.requestId
        || !current.pending.has(editorId)) return;
      if (!parsed.data.prepared) { cancel(); return; }
      current.pending.delete(editorId);
      if (current.pending.size === 0) {
        // Stop the watchdog but retain crash/destroy guards and the admission
        // latch until main starts retirement synchronously after this resolve.
        current.cleanups[0]?.();
        current.resolve();
      }
    },
    cancel,
  };
}
