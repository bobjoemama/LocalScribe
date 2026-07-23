import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, MODEL_PERFORMANCE_MODES } from "../src/shared/contracts";

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
  it("upgrades legacy settings without a mode to Auto and ignores the old concrete model ID", () => {
    const filePath = databasePath();
    const initial = new LocalDatabase(filePath);
    initial.close();

    const legacy = new Database(filePath);
    const { modelPerformanceMode: _mode, ...legacySettings } = DEFAULT_SETTINGS;
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
});
