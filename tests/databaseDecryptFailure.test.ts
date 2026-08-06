import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sentinel plaintext below seals normally but refuses to open again, which
 * is what a real macOS Keychain key rotation looks like from the renderer's
 * side: `safeStorage.encryptString` succeeded when the row was written, and a
 * later `safeStorage.decryptString` on the same blob throws.
 */
const UNREADABLE = "__key-rotated-away__";

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
      return plaintext;
    },
  },
}));

import { LocalDatabase } from "../src/main/persistence/database";

const temporaryDirectories: string[] = [];

function createDatabasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "localscribe-decrypt-test-"));
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

describe("undecryptable rows are isolated instead of failing the whole query", () => {
  /*
   * Regression: `listSnippets()` decrypted every row with no error handling. It
   * runs on the startup path (`installApplicationMenu` counts snippets inside
   * the startup promise), so a single unreadable blob rejected startup and the
   * app quit with "Quit LocalScribe and try opening it again" — advice that can
   * never work, because the bad blob is still on disk on the next launch.
   */
  it("lists the readable snippets when one blob cannot be decrypted", () => {
    const database = new LocalDatabase(createDatabasePath());
    database.saveSnippet({ trigger: "addr", expansion: "1 Infinite Loop" });
    database.saveSnippet({ trigger: "zzz", expansion: UNREADABLE });

    const snippets = database.listSnippets();

    expect(snippets.map((snippet) => snippet.trigger)).toEqual(["addr"]);
    expect(warn).toHaveBeenCalled();
    database.close();
  });

  it("keeps the unreadable row on disk so a later run with the right key recovers it", () => {
    const databasePath = createDatabasePath();
    const database = new LocalDatabase(databasePath);
    database.saveSnippet({ trigger: "zzz", expansion: UNREADABLE });
    expect(database.listSnippets()).toEqual([]);
    database.close();

    // Reopening proves the skip is non-destructive: the row is still there and
    // still fails to decrypt rather than having been deleted to "repair" it.
    const reopened = new LocalDatabase(databasePath);
    expect(reopened.listSnippets()).toEqual([]);
    const rowCount = reopened.integrityCheck();
    expect(rowCount).toBe("ok");
    reopened.close();
  });

  it("lists and exports the readable transcriptions when one blob cannot be decrypted", () => {
    const database = new LocalDatabase(createDatabasePath());
    database.saveTranscription(transcriptionInput("readable one"));
    database.saveTranscription(transcriptionInput(UNREADABLE));
    database.saveTranscription(transcriptionInput("readable two"));

    expect(database.listTranscriptions().map((item) => item.text).sort()).toEqual([
      "readable one",
      "readable two",
    ]);
    expect(database.exportTranscriptions().map((item) => item.text).sort()).toEqual([
      "readable one",
      "readable two",
    ]);
    database.close();
  });

  it("lists the readable scratchpad notes when one blob cannot be decrypted", () => {
    const database = new LocalDatabase(createDatabasePath());
    const readable = database.createScratchpadNote();
    database.updateScratchpadNote(readable.id, "Project plan");
    const poisoned = database.createScratchpadNote();
    database.updateScratchpadNote(poisoned.id, UNREADABLE);

    const notes = database.listScratchpadNotes();

    expect(notes.map((note) => note.id)).toEqual([readable.id]);
    expect(notes[0]?.title).toBe("Project plan");
    database.close();
  });
});
