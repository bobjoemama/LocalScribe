import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Partial data is the dangerous failure here, not lost data.
 *
 * A row this install can no longer decrypt is skipped so that one bad blob
 * cannot blank an entire history — but a silent skip turns an *export* into a
 * short file the user keeps and believes is complete. That is worse than an
 * export that fails outright, because nothing ever tells them.
 *
 * Two guarantees follow, and neither is checkable by reading source:
 *
 *   - the count of skipped records travels with the records,
 *   - a decryption failure is tolerated, but any other error is a bug in our
 *     own code and must be rethrown rather than counted as user corruption.
 *
 * Rows are never deleted on either path. An unreadable blob becomes readable
 * again the moment a keychain entry is restored, so deleting it would destroy
 * recoverable user data to tidy up a symptom.
 */

/** Seals normally, refuses to open — a real macOS Keychain rotation. */
const UNREADABLE = "__key-rotated-away__";
/** Not a decryption failure at all: a fault in our own code. */
const CODE_DEFECT = "__type-error__";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) =>
      Buffer.from(`cipher:${Buffer.from(value, "utf8").toString("base64")}`),
    decryptString: (value: Buffer) => {
      const encoded = value.toString("utf8").replace(/^cipher:/u, "");
      const plaintext = Buffer.from(encoded, "base64").toString("utf8");
      if (plaintext === UNREADABLE) {
        throw new Error("Error while decrypting the ciphertext provided to safeStorage");
      }
      if (plaintext === CODE_DEFECT) {
        throw new TypeError("Cannot read properties of undefined (reading 'length')");
      }
      return plaintext;
    },
  },
}));

const { LocalDatabase } = await import("../src/main/persistence/database");

const temporaryDirectories: string[] = [];

function createDatabasePath(): string {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "localscribe-partial-data-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "test.db");
}

function transcriptionInput(text: string) {
  return {
    durationMs: 1_000,
    text,
    language: "en",
    modelId: "whisper-large-v3-turbo",
    status: "complete" as const,
    sourceAppId: null,
  };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("an export states whether it is complete", () => {
  it("reports the records it could not read instead of quietly omitting them", () => {
    const database = new LocalDatabase(createDatabasePath());
    database.saveTranscription(transcriptionInput("readable one"));
    database.saveTranscription(transcriptionInput(UNREADABLE));
    database.saveTranscription(transcriptionInput("readable two"));

    const result = database.exportTranscriptionsWithIntegrity();

    expect(result.transcriptions.map((item) => item.text).sort())
      .toEqual(["readable one", "readable two"]);
    expect(result.skippedUnreadable).toBe(1);
    expect(result.complete).toBe(false);
    database.close();
  });

  it("declares a genuinely complete export complete", () => {
    const database = new LocalDatabase(createDatabasePath());
    database.saveTranscription(transcriptionInput("readable one"));
    database.saveTranscription(transcriptionInput("readable two"));

    const result = database.exportTranscriptionsWithIntegrity();

    expect(result.skippedUnreadable).toBe(0);
    expect(result.complete).toBe(true);
    expect(result.transcriptions).toHaveLength(2);
    database.close();
  });

  /*
   * The skip count is a per-export delta, not the running process total. An
   * export that reported every unreadable row ever seen in the session would
   * overstate its own incompleteness and be just as untrustworthy.
   */
  it("counts per export rather than accumulating across the process", () => {
    const database = new LocalDatabase(createDatabasePath());
    database.saveTranscription(transcriptionInput("readable"));
    database.saveTranscription(transcriptionInput(UNREADABLE));

    expect(database.exportTranscriptionsWithIntegrity().skippedUnreadable).toBe(1);
    expect(database.exportTranscriptionsWithIntegrity().skippedUnreadable).toBe(1);
    expect(database.exportTranscriptionsWithIntegrity().skippedUnreadable).toBe(1);
    database.close();
  });

  it("declares an export of nothing complete rather than suspicious", () => {
    const database = new LocalDatabase(createDatabasePath());

    const result = database.exportTranscriptionsWithIntegrity();

    expect(result).toMatchObject({ skippedUnreadable: 0, complete: true });
    expect(result.transcriptions).toEqual([]);
    database.close();
  });
});

describe("the unreadable-record signal", () => {
  it("starts at zero and rises only when a record cannot be read", () => {
    const database = new LocalDatabase(createDatabasePath());
    expect(database.unreadableRecordCount()).toBe(0);

    database.saveTranscription(transcriptionInput("readable"));
    database.listTranscriptions();
    expect(database.unreadableRecordCount()).toBe(0);

    database.saveTranscription(transcriptionInput(UNREADABLE));
    database.listTranscriptions();
    expect(database.unreadableRecordCount()).toBe(1);
    database.close();
  });

  /*
   * Documented as counting reads rather than distinct rows: it is a "something
   * is wrong, and roughly this much" signal for diagnostics, not an inventory.
   */
  it("counts reads, so the same row seen twice counts twice", () => {
    const database = new LocalDatabase(createDatabasePath());
    database.saveTranscription(transcriptionInput(UNREADABLE));

    database.listTranscriptions();
    database.listTranscriptions();

    expect(database.unreadableRecordCount()).toBe(2);
    database.close();
  });

  it("fills the readable LIMIT and reports skipped and total stored rows", () => {
    const database = new LocalDatabase(createDatabasePath());
    database.saveTranscription(transcriptionInput("readable one"));
    database.saveTranscription(transcriptionInput(UNREADABLE));
    database.saveTranscription(transcriptionInput("readable two"));

    expect(database.listTranscriptions(2).map((item) => item.text).sort()).toEqual([
      "readable one",
      "readable two",
    ]);
    const result = database.listTranscriptionsWithIntegrity(2);
    expect(result.items.map((item) => item.text).sort()).toEqual([
      "readable one",
      "readable two",
    ]);
    expect(result).toMatchObject({
      totalStored: 3,
      skippedUnreadable: 1,
      complete: false,
    });
    database.close();
  });

  it("isolates malformed and oversized history rows without hiding valid siblings", () => {
    const filePath = createDatabasePath();
    const database = new LocalDatabase(filePath);
    const first = database.saveTranscription(transcriptionInput("readable one"));
    database.saveTranscription(transcriptionInput("readable two"));
    const raw = new Database(filePath);
    const encrypted = raw.prepare(
      "SELECT text_encrypted FROM transcriptions WHERE id = ?",
    ).get(first.id) as { text_encrypted: Buffer };
    const insert = raw.prepare(
      `INSERT INTO transcriptions
         (id, created_at, duration_ms, text_encrypted, language, model_id, status, source_app_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("malformed-id", Date.now(), -1, encrypted.text_encrypted, "en", "model", "complete", null);
    insert.run(
      "00000000-0000-4000-8000-000000000099",
      Date.now(),
      1,
      Buffer.alloc(2 * 1024 * 1024 + 1),
      "en",
      "model",
      "complete",
      null,
    );
    raw.close();

    const result = database.listTranscriptionsWithIntegrity(10);
    expect(result.items.map((item) => item.text).sort()).toEqual([
      "readable one",
      "readable two",
    ]);
    expect(result).toMatchObject({ totalStored: 4, skippedUnreadable: 2, complete: false });
    database.close();
  });

  it("refuses to materialize an excessive export collection", () => {
    const filePath = createDatabasePath();
    const database = new LocalDatabase(filePath);
    const raw = new Database(filePath);
    raw.prepare(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 10001
       )
       INSERT INTO transcriptions
         (id, created_at, duration_ms, text_encrypted, language, model_id, status, source_app_id)
       SELECT 'excess-' || value, value, 1, ?, 'en', 'model', 'complete', NULL
       FROM sequence`,
    ).run(Buffer.from("cipher:cmVhZGFibGU=", "utf8"));
    raw.close();

    expect(() => database.exportTranscriptionsWithIntegrity()).toThrow(/safe row limit/u);
    database.close();
  });
});

/*
 * The guard that keeps a bug in our own code from being filed as user data
 * corruption. Swallowing a TypeError here would silently shrink every list in
 * the app and blame the user's keychain for it.
 */
describe("only decryption failures are tolerated", () => {
  it("rethrows a programming fault instead of skipping the row", () => {
    const database = new LocalDatabase(createDatabasePath());
    database.saveTranscription(transcriptionInput("readable"));
    database.saveTranscription(transcriptionInput(CODE_DEFECT));

    expect(() => database.listTranscriptions()).toThrow(TypeError);
    database.close();
  });

  it("does not count a programming fault as an unreadable user record", () => {
    const database = new LocalDatabase(createDatabasePath());
    database.saveTranscription(transcriptionInput(CODE_DEFECT));

    expect(() => database.listTranscriptions()).toThrow(TypeError);
    expect(database.unreadableRecordCount()).toBe(0);
    database.close();
  });

  it("fails the export rather than declaring it complete-but-short", () => {
    const database = new LocalDatabase(createDatabasePath());
    database.saveTranscription(transcriptionInput("readable"));
    database.saveTranscription(transcriptionInput(CODE_DEFECT));

    expect(() => database.exportTranscriptionsWithIntegrity()).toThrow(TypeError);
    database.close();
  });
});

describe("unreadable rows are never deleted", () => {
  it("keeps every row on disk after listing and exporting", () => {
    const databasePath = createDatabasePath();
    const database = new LocalDatabase(databasePath);
    database.saveTranscription(transcriptionInput("readable"));
    database.saveTranscription(transcriptionInput(UNREADABLE));

    for (let index = 0; index < 5; index += 1) {
      database.listTranscriptions();
      database.exportTranscriptionsWithIntegrity();
    }
    database.close();

    // Reopen and count rows directly: the skipped row must still be there, so
    // restoring the keychain entry recovers it.
    const reopened = new LocalDatabase(databasePath);
    const rows = (reopened as unknown as {
      db: { prepare(sql: string): { get(): { total: number } } };
    }).db.prepare("SELECT COUNT(*) AS total FROM transcriptions").get();

    expect(rows.total).toBe(2);
    reopened.close();
  });

  it("recovers the row once decryption works again", () => {
    const databasePath = createDatabasePath();
    const first = new LocalDatabase(databasePath);
    first.saveTranscription(transcriptionInput("readable"));
    first.saveTranscription(transcriptionInput(UNREADABLE));
    expect(first.listTranscriptions()).toHaveLength(1);
    first.close();

    // The blob was preserved verbatim, so a run whose keychain can open it
    // sees both records. Simulated by reading the stored value directly.
    const reopened = new LocalDatabase(databasePath);
    const stored = (reopened as unknown as {
      db: { prepare(sql: string): { all(): Array<{ text_encrypted: Buffer }> } };
    }).db.prepare("SELECT text_encrypted FROM transcriptions").all();

    const decoded = stored.map((row) => Buffer.from(
      row.text_encrypted.toString("utf8").replace(/^cipher:/u, ""),
      "base64",
    ).toString("utf8"));
    expect(decoded).toContain(UNREADABLE);
    reopened.close();
  });
});

describe("the warning about an unreadable record", () => {
  it("says that one failed and nothing about what it contained", () => {
    const database = new LocalDatabase(createDatabasePath());
    database.saveTranscription(transcriptionInput(UNREADABLE));
    database.listTranscriptions();

    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("could not decrypt a stored record");
    // Neither the plaintext sentinel nor the ciphertext may appear.
    expect(logged).not.toContain(UNREADABLE);
    expect(logged).not.toContain("cipher:");
    database.close();
  });
});
