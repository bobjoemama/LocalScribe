import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * A transparent "encryption" so the test can look for the exact bytes the
 * database wrote. The real safeStorage seal is opaque and machine-bound; what
 * matters here is only that a distinctive byte sequence reaches the file.
 */
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`cipher:${value}`, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8").replace(/^cipher:/u, ""),
  },
}));

import Database from "better-sqlite3";

import { LocalDatabase } from "../src/main/persistence/database";

const temporaryDirectories: string[] = [];

function createDatabasePath(): string {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "localscribe-secure-delete-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "test.db");
}

function transcriptionInput(text: string) {
  return {
    durationMs: 1_000,
    text,
    language: "en",
    modelId: "whisper-large-v3-mlx",
    status: "complete" as const,
    sourceAppId: null,
  };
}

/** The database file plus its WAL, which is where recent pages actually live. */
function storedBytes(databasePath: string): Buffer {
  const parts = [readFileSync(databasePath)];
  for (const suffix of ["-wal", "-shm"]) {
    try {
      parts.push(readFileSync(`${databasePath}${suffix}`));
    } catch {
      // Absent journals simply contribute nothing.
    }
  }
  return Buffer.concat(parts);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/*
 * "Clear history" deletes encrypted transcripts from LocalScribe history. With
 * SQLite's default settings that was not true: a DELETE unlinks the row but
 * leaves the freed page contents in the file until some later insert happens to
 * reuse the page, so every "deleted" transcript stayed on disk byte for byte.
 * `secure_delete = ON` overwrites freed cells in the current database state.
 * LocalDatabase additionally requires a successful truncating WAL checkpoint
 * before reporting the deletion successful, because an older frame can retain
 * ciphertext while another reader pins the WAL.
 */
describe("deleted transcripts leave no residue in the database file", () => {
  const SENTINEL = "quarterly-forecast-sentinel-9f2c41";

  it("removes the stored bytes when history is cleared", () => {
    const databasePath = createDatabasePath();
    const database = new LocalDatabase(databasePath);
    database.saveTranscription(transcriptionInput(SENTINEL));
    expect(storedBytes(databasePath).includes(SENTINEL)).toBe(true);

    database.clearTranscriptions();
    database.close();

    expect(storedBytes(databasePath).includes(SENTINEL)).toBe(false);
  });

  it("removes the stored bytes when a single transcript is deleted", () => {
    const databasePath = createDatabasePath();
    const database = new LocalDatabase(databasePath);
    const saved = database.saveTranscription(transcriptionInput(SENTINEL));
    expect(storedBytes(databasePath).includes(SENTINEL)).toBe(true);

    database.deleteTranscription(saved.id);
    database.close();

    expect(storedBytes(databasePath).includes(SENTINEL)).toBe(false);
  });

  /*
   * The retention purge is a plain DELETE, so it inherits the same pragma —
   * but the README now states that automatic expiry overwrites the bytes, so
   * that claim needs a test rather than an inference.
   */
  it("removes the stored bytes when retention expires a transcript", () => {
    const databasePath = createDatabasePath();
    const database = new LocalDatabase(databasePath);
    const saved = database.saveTranscription(transcriptionInput(SENTINEL));
    // Backdate past a 7-day window through a second connection: the row's
    // timestamp is not writable through the application's own API.
    const backdate = new Database(databasePath);
    backdate
      .prepare("UPDATE transcriptions SET created_at = ? WHERE id = ?")
      .run(Date.now() - 8 * 24 * 60 * 60 * 1000, saved.id);
    backdate.close();
    expect(storedBytes(databasePath).includes(SENTINEL)).toBe(true);

    expect(database.purgeExpiredTranscriptions(7)).toBe(1);
    database.close();

    expect(storedBytes(databasePath).includes(SENTINEL)).toBe(false);
  });

  it("keeps a transcript that was not deleted", () => {
    const databasePath = createDatabasePath();
    const database = new LocalDatabase(databasePath);
    const keep = database.saveTranscription(transcriptionInput("kept-transcript-sentinel"));
    database.saveTranscription(transcriptionInput(SENTINEL));

    const removed = database.listTranscriptions(10).find((row) => row.text === SENTINEL);
    expect(removed).toBeDefined();
    database.deleteTranscription(removed!.id);
    database.close();

    const bytes = storedBytes(databasePath);
    expect(bytes.includes(SENTINEL)).toBe(false);
    expect(bytes.includes("kept-transcript-sentinel")).toBe(true);
    expect(keep.text).toBe("kept-transcript-sentinel");
  });

  it("reports physical cleanup failure when a reader pins the WAL", () => {
    const databasePath = createDatabasePath();
    const database = new LocalDatabase(databasePath);
    const saved = database.saveTranscription(transcriptionInput(SENTINEL));
    const reader = new Database(databasePath, { readonly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT text_encrypted FROM transcriptions WHERE id = ?").get(saved.id);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => database.deleteTranscription(saved.id)).toThrow(/cleanup could not be completed/u);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("could not complete physical single history deletion cleanup"),
    );

    reader.exec("ROLLBACK");
    reader.close();
    warning.mockRestore();
    database.close();
    expect(storedBytes(databasePath).includes(SENTINEL)).toBe(false);
  });
});
