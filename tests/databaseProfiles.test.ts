import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
}));

import { LocalDatabase } from "../src/main/persistence/database";

const temporaryDirectories: string[] = [];

function createDatabase(): LocalDatabase {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "localscribe-profile-test-"));
  temporaryDirectories.push(directory);
  return new LocalDatabase(path.join(directory, "test.db"));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("persisted app-profile identity matching", () => {
  it("normalizes and updates a differently-cased bundle identifier", () => {
    const database = createDatabase();
    const first = database.saveProfile({
      appId: " COM.APPLE.TextEdit ",
      label: "TextEdit",
      removeFillers: true,
      spokenCommands: true,
      smartPunctuation: true,
    });
    const updated = database.saveProfile({
      appId: "com.apple.textedit",
      label: "TextEdit verbatim",
      removeFillers: false,
      spokenCommands: false,
      smartPunctuation: false,
    });

    expect(first.appId).toBe("com.apple.textedit");
    expect(updated.id).toBe(first.id);
    expect(database.listProfiles()).toHaveLength(1);
    expect(database.findProfile("COM.APPLE.TEXTEDIT")).toMatchObject({
      id: first.id,
      label: "TextEdit verbatim",
      removeFillers: false,
    });
    database.close();
  });

  it("isolates malformed profile rows without deleting them or blocking valid profiles", () => {
    const database = createDatabase();
    const valid = database.saveProfile({
      appId: "com.apple.TextEdit",
      label: "TextEdit",
      removeFillers: true,
      spokenCommands: true,
      smartPunctuation: true,
    });
    const raw = (database as unknown as {
      db: {
        prepare(sql: string): {
          run(...values: unknown[]): unknown;
          get(): { total: number };
        };
      };
    }).db;
    const insert = raw.prepare(
      `INSERT INTO app_profiles
         (id, app_id, settings_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run("00000000-0000-4000-8000-000000000002", "invalid.json", "{", 1, 1);
    insert.run(
      "00000000-0000-4000-8000-000000000003",
      "invalid.schema",
      JSON.stringify({ label: "", removeFillers: "yes" }),
      1,
      1,
    );

    expect(database.listProfiles()).toEqual([valid]);
    expect(database.unreadableRecordCount()).toBe(2);
    expect(raw.prepare("SELECT COUNT(*) AS total FROM app_profiles").get().total).toBe(3);

    const repaired = database.saveProfile({
      appId: "INVALID.SCHEMA",
      label: "Repaired",
      removeFillers: false,
      spokenCommands: false,
      smartPunctuation: false,
    });
    expect(repaired.id).toBe("00000000-0000-4000-8000-000000000003");
    expect(database.listProfiles()).toEqual([valid, repaired]);
    expect(raw.prepare("SELECT COUNT(*) AS total FROM app_profiles").get().total).toBe(3);
    database.close();
  });
});
