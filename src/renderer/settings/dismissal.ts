/*
 * Whether the Settings dialog may close right now.
 *
 * `closeSettings` used to make this decision inline, and it only ever consulted
 * `modelApplyInFlight`. Three things followed from that:
 *
 *   1. `SettingsApp`'s `onNavigate` handler never consulted it at all. It calls
 *      `setSettingsOpen(false)` unconditionally, so any tray entry that
 *      navigates the hub — Dictation, Insights, Dictionary, Snippets, Style,
 *      Transforms, Scratchpad — unmounted the dialog mid-operation.
 *   2. A model install, repair, remove, or add was never guarded, only Apply.
 *      Escape during a multi-gigabyte download closed the dialog.
 *   3. A refused close did nothing at all — no message, no movement. The user
 *      presses Escape three times and concludes the app has frozen.
 *
 * Unmounting mid-operation does not cancel anything: main runs model work under
 * `runExclusiveModelOperation`, so the operation continues, and every `setState`
 * after the `await` lands on an unmounted component and is dropped. The user
 * loses the progress line, the success line, and — worst — the failure line that
 * says their previous selection is still active. Because the in-flight refs are
 * per-mount, re-opening Settings resets them to `false`, so a second Apply can
 * be dispatched and simply queues behind the first: a second full unload/reload
 * of a multi-gigabyte model that the user never asked for.
 *
 * The decision is a module so that it can be tested for real. The renderer tests
 * run in a node environment with no jsdom, so an Escape keypress cannot be
 * simulated — but this function can be called directly, and every call site can
 * be pinned to it.
 */

export type SettingsBusyKind = "model" | "save";

export interface SettingsActivity {
  /** Any model apply, install, repair, removal, addition, or explicit refresh. */
  modelOperationInFlight: boolean;
  /** An ordinary settings or shortcut save is awaiting main. */
  settingsSaveInFlight: boolean;
}

export type DismissalDecision =
  | { dismiss: true }
  | { dismiss: false; blockedBy: SettingsBusyKind; message: string };

/*
 * Both messages say the wait is bounded and requires nothing from the user,
 * because the only alternative reading — "this is stuck" — is what makes people
 * force-quit an app mid-model-write. Neither names a model, a path, a URL, or
 * anything else the diagnostics redaction rules keep out of the UI.
 */
export const MODEL_BUSY_MESSAGE =
  "LocalScribe is still completing a model operation. Settings stays open until that finishes, which happens on its own.";

export const SETTINGS_SAVE_BUSY_MESSAGE =
  "LocalScribe is still saving your settings. Settings stays open until that finishes, which happens on its own.";

/** Model work takes precedence if inconsistent caller state reports both. */
export function decideSettingsDismissal(activity: SettingsActivity): DismissalDecision {
  if (activity.modelOperationInFlight) {
    return { dismiss: false, blockedBy: "model", message: MODEL_BUSY_MESSAGE };
  }
  if (activity.settingsSaveInFlight) {
    return { dismiss: false, blockedBy: "save", message: SETTINGS_SAVE_BUSY_MESSAGE };
  }
  return { dismiss: true };
}
