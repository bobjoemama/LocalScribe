import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrations } from "../src/main/persistence/migrations";

const FAIL_ENCRYPTION = "__FAIL_ENCRYPTION__";

function seal(value: string): Buffer {
  return Buffer.from(`sealed:${Buffer.from(value, "utf8").toString("base64")}`, "utf8");
}

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => {
      if (value === FAIL_ENCRYPTION) throw new Error("simulated keychain failure");
      return seal(value);
    },
    decryptString: (value: Buffer) => {
      const stored = value.toString("utf8");
      if (!stored.startsWith("sealed:")) throw new Error("invalid sealed value");
      return Buffer.from(stored.slice("sealed:".length), "base64").toString("utf8");
    },
  },
}));

const { LocalDatabase } = await import("../src/main/persistence/database");

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "localscribe-rule-privacy-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "test.db");
}

function createVersion4Database(
  filePath: string,
  dictionary: { phrase: string; replacement: string } = {
    phrase: "Q when ASR",
    replacement: "Qwen ASR",
  },
): void {
  const legacy = new Database(filePath);
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
    ${migrations[0]!.sql}
    ${migrations[1]!.sql}
    ${migrations[2]!.sql}
    ${migrations[3]!.sql}
  `);
  const recordMigration = legacy.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const migration of migrations.slice(0, 4)) {
    recordMigration.run(migration.version, migration.name, 1);
  }
  legacy.prepare(
    `INSERT INTO dictionary_entries
       (id, phrase, replacement, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "00000000-0000-4000-8000-000000000001",
    dictionary.phrase,
    dictionary.replacement,
    1,
    1,
  );
  legacy.prepare(
    `INSERT INTO snippets
       (id, trigger, expansion_encrypted, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "00000000-0000-4000-8000-000000000002",
    "my sign off",
    seal("\n  Best,\n    Alice\n"),
    1,
    1,
  );
  legacy.close();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("private dictionary and snippet fields", () => {
  it("transactionally migrates legacy plaintext and preserves formatted expansions", () => {
    const filePath = databasePath();
    createVersion4Database(filePath);

    const database = new LocalDatabase(filePath);
    expect(database.listDictionary()).toMatchObject([
      { phrase: "Q when ASR", replacement: "Qwen ASR" },
    ]);
    expect(database.listSnippets()).toMatchObject([
      { trigger: "my sign off", expansion: "\n  Best,\n    Alice\n" },
    ]);
    database.close();

    const stored = new Database(filePath, { readonly: true });
    const dictionaryColumns = stored.pragma("table_info(dictionary_entries)") as Array<{ name: string }>;
    const snippetColumns = stored.pragma("table_info(snippets)") as Array<{ name: string }>;
    expect(dictionaryColumns.map((column) => column.name)).not.toContain("phrase");
    expect(dictionaryColumns.map((column) => column.name)).not.toContain("replacement");
    expect(snippetColumns.map((column) => column.name)).not.toContain("trigger");
    const dictionaryRow = stored.prepare(
      "SELECT phrase_encrypted, replacement_encrypted FROM dictionary_entries",
    ).get() as { phrase_encrypted: Buffer; replacement_encrypted: Buffer };
    const snippetRow = stored.prepare(
      "SELECT trigger_encrypted FROM snippets",
    ).get() as { trigger_encrypted: Buffer };
    expect(dictionaryRow.phrase_encrypted.toString("utf8")).not.toContain("Q when ASR");
    expect(dictionaryRow.replacement_encrypted.toString("utf8")).not.toContain("Qwen ASR");
    expect(snippetRow.trigger_encrypted.toString("utf8")).not.toContain("my sign off");
    stored.close();
    for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
      if (!existsSync(candidate)) continue;
      const bytes = readFileSync(candidate).toString("latin1");
      expect(bytes).not.toContain("Q when ASR");
      expect(bytes).not.toContain("Qwen ASR");
      expect(bytes).not.toContain("my sign off");
    }
  });

  it("rolls back without dropping plaintext when encryption verification cannot complete", () => {
    const filePath = databasePath();
    createVersion4Database(filePath, {
      phrase: FAIL_ENCRYPTION,
      replacement: "preserved replacement",
    });

    expect(() => new LocalDatabase(filePath)).toThrow("simulated keychain failure");

    const preserved = new Database(filePath, { readonly: true });
    const row = preserved.prepare(
      "SELECT phrase, replacement FROM dictionary_entries",
    ).get() as { phrase: string; replacement: string };
    expect(row).toEqual({ phrase: FAIL_ENCRYPTION, replacement: "preserved replacement" });
    expect(preserved.prepare(
      "SELECT COUNT(*) AS total FROM dictionary_entries_encrypted",
    ).get()).toEqual({ total: 0 });
    preserved.close();
  });

  it("updates canonically equivalent rules instead of creating duplicates", () => {
    const database = new LocalDatabase(databasePath());
    const firstDictionary = database.saveDictionary({ phrase: "café", replacement: "coffee" });
    const secondDictionary = database.saveDictionary({
      phrase: "cafe\u0301",
      replacement: "espresso",
    });
    const firstSnippet = database.saveSnippet({ trigger: "résumé", expansion: "CV one" });
    const secondSnippet = database.saveSnippet({ trigger: "re\u0301sume\u0301", expansion: "CV two" });

    expect(secondDictionary.id).toBe(firstDictionary.id);
    expect(database.listDictionary()).toMatchObject([{ phrase: "café", replacement: "espresso" }]);
    expect(secondSnippet.id).toBe(firstSnippet.id);
    expect(database.listSnippets()).toMatchObject([{ trigger: "résumé", expansion: "CV two" }]);
    database.close();
  });

  it("isolates malformed encrypted rule metadata without hiding valid rules", () => {
    const filePath = databasePath();
    const database = new LocalDatabase(filePath);
    database.saveDictionary({ phrase: "valid phrase", replacement: "valid replacement" });
    const raw = new Database(filePath);
    raw.prepare(
      `INSERT INTO dictionary_entries
         (id, phrase_encrypted, replacement_encrypted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("invalid-id", seal("bad phrase"), seal("bad replacement"), -1, 1);
    raw.close();

    expect(database.listDictionary()).toMatchObject([
      { phrase: "valid phrase", replacement: "valid replacement" },
    ]);
    expect(database.unreadableRecordCount()).toBe(1);
    database.close();
  });
});
