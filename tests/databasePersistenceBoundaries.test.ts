import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

const TEST_ENCRYPTION_OVERHEAD_BYTES = 64;
const MAX_CIPHERTEXT_SENTINEL = "__max-ciphertext__";
const OVERSIZED_CIPHERTEXT_SENTINEL = "__oversized-ciphertext__";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => {
      if (value === MAX_CIPHERTEXT_SENTINEL) return Buffer.alloc(2 * 1024 * 1024, 0xb6);
      if (value === OVERSIZED_CIPHERTEXT_SENTINEL) return Buffer.alloc(2 * 1024 * 1024 + 1);
      return Buffer.concat([
        Buffer.alloc(TEST_ENCRYPTION_OVERHEAD_BYTES, 0xa5),
        Buffer.from(value, "utf8"),
      ]);
    },
    decryptString: (value: Buffer) => value.byteLength === 2 * 1024 * 1024
      ? MAX_CIPHERTEXT_SENTINEL
      : value.subarray(TEST_ENCRYPTION_OVERHEAD_BYTES).toString("utf8"),
  },
}));

import { LocalDatabase } from "../src/main/persistence/database";
import {
  MAX_PERSISTED_PRIVATE_TEXT_CIPHERTEXT_BYTES,
  MAX_PERSISTED_PRIVATE_TEXT_UTF8_BYTES,
} from "../src/shared/contracts";

const temporaryDirectories: string[] = [];

function createDatabase(): { database: LocalDatabase; filePath: string } {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "localscribe-private-text-limit-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "test.db");
  return { database: new LocalDatabase(filePath), filePath };
}

function transcriptionInput(text: string, sourceAppId: string | null = null) {
  return {
    durationMs: 1_000,
    text,
    language: "en",
    modelId: "model",
    status: "complete" as const,
    sourceAppId,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("private-text persistence boundaries", () => {
  it("stores ASCII and astral plaintext exactly at the shared UTF-8 limit", () => {
    const { database, filePath } = createDatabase();
    const ascii = "a".repeat(MAX_PERSISTED_PRIVATE_TEXT_UTF8_BYTES);
    const astral = "😀".repeat(MAX_PERSISTED_PRIVATE_TEXT_UTF8_BYTES / 4);

    const history = database.saveTranscription(transcriptionInput(ascii));
    const note = database.createScratchpadNote();
    database.updateScratchpadNote(note.id, astral);

    expect(database.listTranscriptions()[0]?.text).toBe(ascii);
    expect(database.listScratchpadNotes()[0]?.body).toBe(astral);

    const raw = new Database(filePath, { readonly: true });
    const historyBlob = raw.prepare(
      "SELECT text_encrypted FROM transcriptions WHERE id = ?",
    ).get(history.id) as { text_encrypted: Buffer };
    const noteBlob = raw.prepare(
      "SELECT body_encrypted FROM scratchpad_notes WHERE id = ?",
    ).get(note.id) as { body_encrypted: Buffer };
    expect(historyBlob.text_encrypted.byteLength)
      .toBe(MAX_PERSISTED_PRIVATE_TEXT_UTF8_BYTES + TEST_ENCRYPTION_OVERHEAD_BYTES);
    expect(noteBlob.body_encrypted.byteLength)
      .toBe(MAX_PERSISTED_PRIVATE_TEXT_UTF8_BYTES + TEST_ENCRYPTION_OVERHEAD_BYTES);
    expect(historyBlob.text_encrypted.byteLength)
      .toBeLessThan(MAX_PERSISTED_PRIVATE_TEXT_CIPHERTEXT_BYTES);
    raw.close();
    database.close();
  });

  it("rejects over-limit ASCII and astral transcripts before inserting any history row", () => {
    const { database } = createDatabase();

    for (const overLimit of [
      "a".repeat(MAX_PERSISTED_PRIVATE_TEXT_UTF8_BYTES + 1),
      "😀".repeat(MAX_PERSISTED_PRIVATE_TEXT_UTF8_BYTES / 4) + "a",
    ]) {
      expect(() => database.saveTranscription(transcriptionInput(overLimit)))
        .toThrow(/UTF-8 storage limit/u);
    }
    expect(database.hasTranscriptions()).toBe(false);
    database.close();
  });

  it("accepts the ciphertext boundary and rejects one byte over before mutation", () => {
    const { database } = createDatabase();
    const note = database.createScratchpadNote();
    database.updateScratchpadNote(note.id, "keep this note");

    const boundary = database.saveTranscription(
      transcriptionInput(MAX_CIPHERTEXT_SENTINEL),
    );
    expect(database.listTranscriptions()).toEqual([
      expect.objectContaining({ id: boundary.id, text: MAX_CIPHERTEXT_SENTINEL }),
    ]);

    expect(() => database.saveTranscription(
      transcriptionInput(OVERSIZED_CIPHERTEXT_SENTINEL),
    )).toThrow(/ciphertext storage limit/u);
    expect(database.listTranscriptions()).toHaveLength(1);

    expect(() => database.updateScratchpadNote(
      note.id,
      "a".repeat(MAX_PERSISTED_PRIVATE_TEXT_UTF8_BYTES + 1),
    )).toThrow(/UTF-8 storage limit/u);
    expect(() => database.updateScratchpadNote(
      note.id,
      OVERSIZED_CIPHERTEXT_SENTINEL,
    )).toThrow(/ciphertext storage limit/u);
    expect(database.listScratchpadNotes()).toEqual([
      expect.objectContaining({ id: note.id, body: "keep this note" }),
    ]);
    database.close();
  });

  it("persists only canonical bundle-like source identities", () => {
    const { database, filePath } = createDatabase();
    const valid = database.saveTranscription(
      transcriptionInput("valid", " COM.APPLE.TextEdit "),
    );
    const pathSource = database.saveTranscription(
      transcriptionInput("path", "/Applications/TextEdit.app/Contents/MacOS/TextEdit"),
    );
    const kelvinSource = database.saveTranscription(
      transcriptionInput("confusable", "\u212Aom.apple.TextEdit"),
    );

    expect(valid.sourceAppId).toBe("com.apple.textedit");
    expect(pathSource.sourceAppId).toBeNull();
    expect(kelvinSource.sourceAppId).toBeNull();
    const raw = new Database(filePath, { readonly: true });
    expect(raw.prepare(
      "SELECT source_app_id FROM transcriptions ORDER BY created_at, id",
    ).all()).toEqual(expect.arrayContaining([
      { source_app_id: "com.apple.textedit" },
      { source_app_id: null },
      { source_app_id: null },
    ]));
    raw.close();
    database.close();
  });
});
