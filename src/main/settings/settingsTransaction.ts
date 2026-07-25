import {
  appSettingsPatchSchema,
  appSettingsSchema,
  type AppSettings,
  type AppSettingsPatch,
} from "../../shared/contracts";
import {
  shortcutUpdateRequestSchema,
} from "../../shared/shortcuts";

export interface SettingsStore {
  getSettings(): AppSettings;
  saveSettings(settings: AppSettings): AppSettings;
}

export interface ShortcutReconfigurer {
  reconfigure(holdShortcut: string, toggleShortcut: string): void;
}

export interface SettingsTransactionDependencies {
  database: SettingsStore;
  hotkeys: ShortcutReconfigurer;
}

/**
 * Persists a validated settings replacement while keeping shortcut activation
 * and persistence all-or-nothing. The caller broadcasts only after this
 * returns, so renderers can never observe an unpersisted shortcut.
 */
export function persistSettingsTransaction(
  { database, hotkeys }: SettingsTransactionDependencies,
  next: AppSettings,
  previous = database.getSettings(),
): AppSettings {
  const validatedPrevious = appSettingsSchema.parse(previous);
  const validatedNext = appSettingsSchema.parse(next);
  const shortcutsChanged = validatedNext.holdShortcut !== validatedPrevious.holdShortcut
    || validatedNext.toggleShortcut !== validatedPrevious.toggleShortcut;
  if (shortcutsChanged) {
    hotkeys.reconfigure(validatedNext.holdShortcut, validatedNext.toggleShortcut);
  }
  try {
    return database.saveSettings(validatedNext);
  } catch (error) {
    if (shortcutsChanged) {
      try {
        hotkeys.reconfigure(validatedPrevious.holdShortcut, validatedPrevious.toggleShortcut);
      } catch (rollbackError) {
        console.error("Could not restore LocalScribe shortcuts after a settings write failed", rollbackError);
      }
    }
    throw error;
  }
}

/** Merge an explicitly selected field set with the latest persisted settings. */
export function applySettingsPatchTransaction(
  dependencies: SettingsTransactionDependencies,
  rawPatch: AppSettingsPatch,
): AppSettings {
  const patch = appSettingsPatchSchema.parse(rawPatch);
  const previous = dependencies.database.getSettings();
  const next = appSettingsSchema.parse({ ...previous, ...patch });
  return persistSettingsTransaction(dependencies, next, previous);
}

/** Commit a recorder value against the latest persisted value of the other key. */
export function applyShortcutUpdateTransaction(
  dependencies: SettingsTransactionDependencies,
  rawRequest: unknown,
): AppSettings {
  const request = shortcutUpdateRequestSchema.parse(rawRequest);
  return applySettingsPatchTransaction(dependencies, {
    [request.kind === "hold" ? "holdShortcut" : "toggleShortcut"]: request.shortcut,
  });
}
