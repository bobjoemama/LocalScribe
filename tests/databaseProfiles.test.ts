import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
}));

import { LocalDatabase } from "../src/main/persistence/database";
import { migrations } from "../src/main/persistence/migrations";

const temporaryDirectories: string[] = [];

function createDatabase(): LocalDatabase {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "localscribe-profile-test-"));
  temporaryDirectories.push(directory);
  return new LocalDatabase(path.join(directory, "test.db"));
}

function createLegacyDatabase(): { database: Database.Database; filePath: string } {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "localscribe-profile-migration-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "test.db");
  const database = new Database(filePath);
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  for (const migration of migrations.filter(({ version }) => version < 6)) {
    database.exec(migration.sql);
    database.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    ).run(migration.version, migration.name, migration.version);
  }
  return { database, filePath };
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

  it("transactionally canonicalizes duplicate profile IDs and preserves the deterministic latest settings", () => {
    const { database: legacy, filePath } = createLegacyDatabase();
    const insert = legacy.prepare(
      `INSERT INTO app_profiles
         (id, app_id, settings_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run(
      "00000000-0000-4000-8000-000000000003",
      "COM.APPLE.TEXTEDIT",
      JSON.stringify({
        label: "Same-time larger ID",
        removeFillers: true,
        spokenCommands: true,
        smartPunctuation: true,
      }),
      200,
      300,
    );
    insert.run(
      "00000000-0000-4000-8000-000000000002",
      "Com.Apple.TextEdit",
      JSON.stringify({
        label: "Deterministic latest",
        removeFillers: false,
        spokenCommands: true,
        smartPunctuation: false,
      }),
      200,
      300,
    );
    insert.run(
      "00000000-0000-4000-8000-000000000001",
      "com.apple.textedit",
      JSON.stringify({
        label: "Older settings",
        removeFillers: true,
        spokenCommands: false,
        smartPunctuation: true,
      }),
      100,
      200,
    );
    legacy.close();

    const migrated = new LocalDatabase(filePath);
    expect(migrated.listProfiles()).toEqual([{
      id: "00000000-0000-4000-8000-000000000002",
      appId: "com.apple.textedit",
      label: "Deterministic latest",
      removeFillers: false,
      spokenCommands: true,
      smartPunctuation: false,
      createdAt: 200,
    }]);
    migrated.close();

    const enforced = new Database(filePath);
    expect(enforced.prepare(
      "SELECT reason FROM app_profiles_identity_recovery ORDER BY id",
    ).all()).toEqual([
      { reason: "case_duplicate" },
      { reason: "case_duplicate" },
    ]);
    expect(() => insertProfile(enforced, {
      id: "00000000-0000-4000-8000-000000000004",
      appId: "COM.APPLE.TEXTEDIT",
    })).toThrow(/UNIQUE constraint failed/u);
    enforced.close();
  });

  it("quarantines Kelvin-sign profile identities without folding them into ASCII profiles", () => {
    const { database: legacy, filePath } = createLegacyDatabase();
    insertProfile(legacy, {
      id: "00000000-0000-4000-8000-000000000020",
      appId: "\u212AOM.APPLE.TEXTEDIT",
    });
    insertProfile(legacy, {
      id: "00000000-0000-4000-8000-000000000021",
      appId: "KOM.APPLE.TEXTEDIT",
    });
    legacy.close();

    const migrated = new LocalDatabase(filePath);
    expect(migrated.listProfiles()).toEqual([
      expect.objectContaining({
        id: "00000000-0000-4000-8000-000000000021",
        appId: "kom.apple.textedit",
      }),
    ]);
    expect(migrated.findProfile("\u212Aom.apple.TextEdit")).toBeNull();
    expect(() => migrated.saveProfile({
      appId: "\u212Aom.apple.TextEdit",
      label: "Must remain invalid",
      removeFillers: false,
      spokenCommands: false,
      smartPunctuation: false,
    })).toThrow();
    migrated.close();

    const raw = new Database(filePath);
    expect(raw.prepare(
      `SELECT id, app_id, settings_json, reason
       FROM app_profiles_identity_recovery`,
    ).get()).toEqual({
      id: "00000000-0000-4000-8000-000000000020",
      app_id: "\u212AOM.APPLE.TEXTEDIT",
      settings_json: JSON.stringify({
        label: "Duplicate",
        removeFillers: true,
        spokenCommands: true,
        smartPunctuation: true,
      }),
      reason: "invalid_identity",
    });
    expect((raw.prepare("SELECT COUNT(*) AS total FROM app_profiles").get() as { total: number }).total)
      .toBe(1);
    expect(() => insertProfile(raw, {
      id: "00000000-0000-4000-8000-000000000022",
      appId: "\u212Aom.apple.textedit",
    })).toThrow(/CHECK constraint failed/u);
    raw.close();
  });

  it("canonicalizes bundle IDs and removes legacy executable paths from history", () => {
    const { database: legacy, filePath } = createLegacyDatabase();
    const insert = legacy.prepare(
      `INSERT INTO transcriptions
         (id, created_at, duration_ms, text_encrypted, language, model_id, status, source_app_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      "00000000-0000-4000-8000-000000000010",
      1,
      1,
      Buffer.from("path row"),
      "en",
      "model",
      "complete",
      "/Applications/Slack.app/Contents/MacOS/Slack",
    );
    insert.run(
      "00000000-0000-4000-8000-000000000011",
      2,
      1,
      Buffer.from("bundle row"),
      "en",
      "model",
      "complete",
      " COM.TINY.Slack ",
    );
    insert.run(
      "00000000-0000-4000-8000-000000000012",
      3,
      1,
      Buffer.from("confusable row"),
      "en",
      "model",
      "complete",
      "\u212Aom.tiny.Slack",
    );
    legacy.close();

    const migrated = new LocalDatabase(filePath);
    expect(migrated.listTranscriptions(10).map(({ sourceAppId }) => sourceAppId))
      .toEqual([null, "com.tiny.slack", null]);
    migrated.close();

    const raw = new Database(filePath, { readonly: true });
    expect(raw.prepare(
      "SELECT source_app_id FROM transcriptions ORDER BY created_at",
    ).all()).toEqual([
      { source_app_id: null },
      { source_app_id: "com.tiny.slack" },
      { source_app_id: null },
    ]);
    raw.close();
  });
});

function insertProfile(database: Database.Database, input: { id: string; appId: string }): void {
  database.prepare(
    `INSERT INTO app_profiles
       (id, app_id, settings_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.appId,
    JSON.stringify({
      label: "Duplicate",
      removeFillers: true,
      spokenCommands: true,
      smartPunctuation: true,
    }),
    1,
    1,
  );
}
