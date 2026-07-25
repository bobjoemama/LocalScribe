import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`cipher:${Buffer.from(value, "utf8").toString("base64")}`),
    decryptString: (value: Buffer) => {
      const encoded = value.toString("utf8").replace(/^cipher:/, "");
      return Buffer.from(encoded, "base64").toString("utf8");
    },
  },
}));

import { LocalDatabase } from "../src/main/persistence/database";

const temporaryDirectories: string[] = [];

function createDatabasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "localscribe-scratchpad-test-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "test.db");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("encrypted multi-note scratchpad persistence", () => {
  it("creates distinct notes, derives their titles, and updates only the requested note", () => {
    const database = new LocalDatabase(createDatabasePath());
    const first = database.createScratchpadNote();
    const second = database.createScratchpadNote();
    const updatedFirst = database.updateScratchpadNote(first.id, "\n  Project plan  \nSecond line");

    expect(first).toMatchObject({ body: "", title: "Untitled" });
    expect(second.id).not.toBe(first.id);
    expect(updatedFirst).toMatchObject({
      id: first.id,
      body: "\n  Project plan  \nSecond line",
      title: "Project plan",
      createdAt: first.createdAt,
    });
    expect(updatedFirst.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    expect(database.listScratchpadNotes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, title: "Project plan" }),
        expect.objectContaining({ id: second.id, body: "", title: "Untitled" }),
      ]),
    );

    database.deleteScratchpadNote(first.id);
    expect(database.listScratchpadNotes()).toEqual([second]);
    database.close();
  });

  it("migrates the encrypted singleton draft into a note without decrypting it in SQL", () => {
    const databasePath = createDatabasePath();
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO schema_migrations (version, name, applied_at) VALUES
        (1, 'local_first_core', 1),
        (2, 'encrypted_scratchpad', 2);
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE scratchpad (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        body_encrypted BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    legacy
      .prepare("INSERT INTO scratchpad (id, body_encrypted, updated_at) VALUES (1, ?, ?)")
      .run(Buffer.from("cipher:TGVnYWN5IGRyYWZ0", "utf8"), 123);
    legacy.close();

    const database = new LocalDatabase(databasePath);
    expect(database.listScratchpadNotes()).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000001",
        body: "Legacy draft",
        title: "Legacy draft",
        createdAt: 123,
        updatedAt: 123,
      },
    ]);
    database.close();

    const migrated = new Database(databasePath, { readonly: true });
    expect(migrated.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scratchpad'",
    ).get()).toBeUndefined();
    migrated.close();
  });

  it("drops legacy storage without resurrecting a singleton after multi-note migration", () => {
    const databasePath = createDatabasePath();
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO schema_migrations (version, name, applied_at) VALUES
        (1, 'local_first_core', 1),
        (2, 'encrypted_scratchpad', 2),
        (3, 'encrypted_multi_note_scratchpad', 3);
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE scratchpad (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        body_encrypted BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE scratchpad_notes (
        id TEXT PRIMARY KEY,
        body_encrypted BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    legacy
      .prepare("INSERT INTO scratchpad (id, body_encrypted, updated_at) VALUES (1, ?, ?)")
      .run(Buffer.from("cipher:RGVsZXRlZCBsZWdhY3k=", "utf8"), 100);
    legacy
      .prepare(
        `INSERT INTO scratchpad_notes (id, body_encrypted, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        "00000000-0000-4000-8000-000000000002",
        Buffer.from("cipher:Q3VycmVudCBub3Rl", "utf8"),
        200,
        200,
      );
    legacy.close();

    const database = new LocalDatabase(databasePath);
    expect(database.listScratchpadNotes()).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000002",
        body: "Current note",
        title: "Current note",
        createdAt: 200,
        updatedAt: 200,
      },
    ]);
    database.close();

    const migrated = new Database(databasePath, { readonly: true });
    expect(migrated.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scratchpad'",
    ).get()).toBeUndefined();
    migrated.close();
  });

  it("stores note bodies as encrypted SQLite blobs", () => {
    const databasePath = createDatabasePath();
    const database = new LocalDatabase(databasePath);
    const note = database.createScratchpadNote();
    database.updateScratchpadNote(note.id, "Sensitive scratchpad body");
    database.close();

    const rawDatabase = new Database(databasePath, { readonly: true });
    const row = rawDatabase
      .prepare("SELECT body_encrypted FROM scratchpad_notes WHERE id = ?")
      .get(note.id) as { body_encrypted: Buffer };
    expect(row.body_encrypted).toBeInstanceOf(Buffer);
    expect(row.body_encrypted.toString("utf8")).not.toContain("Sensitive scratchpad body");
    rawDatabase.close();
  });
});
