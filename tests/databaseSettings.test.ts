import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  MODEL_PERFORMANCE_MODES,
  type AppSettings,
} from "../src/shared/contracts";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
}));

import { LocalDatabase } from "../src/main/persistence/database";

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "localscribe-settings-test-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "test.db");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("model performance settings persistence", () => {
  it("uses an injected platform default only for a fresh database and preserves existing settings", () => {
    const filePath = databasePath();
    const macDefault: AppSettings = {
      ...DEFAULT_SETTINGS,
      activeModelFamilyId: "parakeet-unified-en-0-6b",
      modelLibraryFamilyIds: ["parakeet-unified-en-0-6b"],
      asrMode: "after-stop",
    };
    const fresh = new LocalDatabase(filePath, macDefault);
    expect(fresh.getSettings()).toEqual(macDefault);
    fresh.saveSettings(DEFAULT_SETTINGS);
    fresh.close();

    const reopened = new LocalDatabase(filePath, macDefault);
    expect(reopened.getSettings()).toEqual(DEFAULT_SETTINGS);
    reopened.close();
  });

  it("upgrades legacy settings without a mode to Auto and ignores the old concrete model ID", () => {
    const filePath = databasePath();
    const initial = new LocalDatabase(filePath);
    initial.close();

    const legacy = new Database(filePath);
    const {
      modelPerformanceMode: _mode,
      activeModelFamilyId: _activeFamily,
      modelLibraryFamilyIds: _libraryFamilies,
      ...legacySettings
    } = DEFAULT_SETTINGS;
    legacy.prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES ('app', ?, ?)",
    ).run(JSON.stringify({
      ...legacySettings,
      modelId: "renderer-controlled/legacy-model",
    }), 1);
    legacy.close();

    const database = new LocalDatabase(filePath);
    expect(database.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(database.getSettings()).not.toHaveProperty("modelId");
    database.close();
  });

  it("round-trips each validated mode", () => {
    const database = new LocalDatabase(databasePath());
    for (const modelPerformanceMode of MODEL_PERFORMANCE_MODES) {
      database.saveSettings({ ...DEFAULT_SETTINGS, modelPerformanceMode });
      expect(database.getSettings().modelPerformanceMode).toBe(modelPerformanceMode);
    }
    database.close();
  });

  it("persists a field-level upgrade of legacy and partially invalid settings", () => {
    const filePath = databasePath();
    const initial = new LocalDatabase(filePath);
    initial.close();

    const legacy = new Database(filePath);
    legacy.prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES ('app', ?, ?)",
    ).run(JSON.stringify({
      ...DEFAULT_SETTINGS,
      launchAtLogin: true,
      language: "German",
      historyRetentionDays: 14,
      modelPerformanceMode: "retired-mode",
      activeModelFamilyId: "whisper-large-v2",
      modelLibraryFamilyIds: ["whisper-large-v3"],
      holdShortcut: "ctrl + option + f13",
      toggleShortcut: "ctrl + option + f13",
      removedLegacyField: "ignored",
    }), 1);
    legacy.close();

    const database = new LocalDatabase(filePath);
    expect(database.getSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      launchAtLogin: true,
      language: "German",
      holdShortcut: "Control+Alt+F13",
    });
    database.close();

    const persisted = new Database(filePath, { readonly: true });
    const row = persisted.prepare(
      "SELECT value_json FROM settings WHERE key = 'app'",
    ).get() as { value_json: string };
    const normalized = JSON.parse(row.value_json) as AppSettings & Record<string, unknown>;
    expect(normalized).not.toHaveProperty("removedLegacyField");
    expect(normalized.historyRetentionDays).toBe(DEFAULT_SETTINGS.historyRetentionDays);
    expect(normalized.modelPerformanceMode).toBe(DEFAULT_SETTINGS.modelPerformanceMode);
    expect(normalized.activeModelFamilyId).toBe(DEFAULT_SETTINGS.activeModelFamilyId);
    persisted.close();
  });

  it("repairs a legacy shortcut conflict even when the hold key equals the current toggle default", () => {
    const filePath = databasePath();
    const initial = new LocalDatabase(filePath);
    initial.close();

    const legacy = new Database(filePath);
    legacy.prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES ('app', ?, ?)",
    ).run(JSON.stringify({
      ...DEFAULT_SETTINGS,
      holdShortcut: DEFAULT_SETTINGS.toggleShortcut,
      toggleShortcut: DEFAULT_SETTINGS.toggleShortcut,
    }), 1);
    legacy.close();

    const database = new LocalDatabase(filePath);
    expect(database.getSettings()).toMatchObject({
      holdShortcut: DEFAULT_SETTINGS.holdShortcut,
      toggleShortcut: DEFAULT_SETTINGS.toggleShortcut,
    });
    database.close();
  });

  it("returns isolated defaults and validates direct writes", () => {
    const database = new LocalDatabase(databasePath());
    const first = database.getSettings();
    first.modelLibraryFamilyIds.push("whisper-large-v2");
    expect(database.getSettings().modelLibraryFamilyIds).toEqual(["whisper-large-v3"]);

    expect(() => database.saveSettings({
      ...DEFAULT_SETTINGS,
      historyRetentionDays: 14,
    } as unknown as AppSettings)).toThrow();
    database.close();
  });

  it("backs up malformed settings JSON and recovers with validated defaults", () => {
    const filePath = databasePath();
    const initial = new LocalDatabase(filePath);
    initial.close();

    const damaged = new Database(filePath);
    damaged.prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES ('app', ?, ?)",
    ).run('{"launchAtLogin":true', 1);
    damaged.close();

    const recovered = new LocalDatabase(filePath);
    expect(recovered.getSettings()).toEqual(DEFAULT_SETTINGS);
    recovered.close();

    const persisted = new Database(filePath, { readonly: true });
    const backupRows = persisted.prepare(
      "SELECT key, value_json FROM settings WHERE key LIKE 'app.corrupt.%'",
    ).all() as Array<{ key: string; value_json: string }>;
    expect(backupRows).toHaveLength(1);
    expect(backupRows[0]?.value_json).toBe('{"launchAtLogin":true');
    persisted.close();
  });
});
