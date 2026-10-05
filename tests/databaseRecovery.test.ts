import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../src/shared/contracts";
import { rendererSurfaceCanInvoke } from "../src/main/ipcAuthorization";
vi.mock("electron", () => ({ safeStorage: {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`sealed:${text}`),
  decryptString: (bytes: Buffer) => {
    if (!bytes.toString().startsWith("sealed:")) throw new Error("Unrecognized encryption key");
    return bytes.toString().slice(7);
  },
} }));
const { LocalDatabase } = await import("../src/main/persistence/database");
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "localscribe-recovery-")); directories.push(directory);
  const file = path.join(directory, "test.db");
  return { directory, file, database: new LocalDatabase(file) };
}
describe("saved data recovery", () => {
  it("archives unreadable ciphertext including WAL before reset, retains configuration and permits new dictionary terms", async () => {
    const { directory, file, database } = fixture();
    try {
      database.saveDictionary({ phrase: "Devish", replacement: "Devesh" });
      database.saveSnippet({ trigger: "address", expansion: "Example address" });
      database.createScratchpadNote();
      database.saveTranscription({ text: "example", durationMs: 1, language: null, modelId: "test", status: "complete" });
      const raw = new Database(file);
      raw.prepare("update dictionary_entries set phrase_encrypted=?").run(Buffer.from("other-key"));
      raw.close();
      expect(database.savedDataStatus()).toEqual({ history: 0, dictionary: 1, snippets: 0, notes: 0 });
      expect(() => database.saveDictionary({ phrase: "new", replacement: "New" })).toThrow("unreadable");
      const settings = database.getSettings();
      const copy = path.join(directory, "recovery", "copy.db");
      await database.backupSavedData(copy);
      expect(statSync(copy).mode & 0o777).toBe(0o600);
      const archived = new Database(copy, { readonly: true });
      expect(archived.prepare("select count(*) as count from transcriptions").get()).toEqual({ count: 1 });
      expect((archived.prepare("select phrase_encrypted from dictionary_entries").get() as {phrase_encrypted: Buffer}).phrase_encrypted).toEqual(Buffer.from("other-key"));
      archived.close();
      expect(database.resetSavedData()).toEqual({ cleanupComplete: true });
      expect(database.savedDataStatus()).toEqual({ history: 0, dictionary: 0, snippets: 0, notes: 0 });
      expect(database.getSettings()).toEqual(settings);
      expect(database.listScratchpadNotesWithIntegrity().items).toEqual([]);
      expect(database.saveDictionary({ phrase: "Devish", replacement: "Devesh" }).replacement).toBe("Devesh");
    } finally { database.close(); }
  });
  it("does not overwrite an existing recovery copy or lose saved data after backup rejection", async () => {
    const { directory, database } = fixture();
    try {
      database.saveDictionary({ phrase: "term", replacement: "Term" });
      const copy = path.join(directory, "copy.db"); await database.backupSavedData(copy);
      await expect(database.backupSavedData(copy)).rejects.toThrow("already exists");
      expect(database.listDictionary()).toHaveLength(1);
    } finally { database.close(); }
  });
  it("rolls back all deletions if one collection cannot reset", () => {
    const { file, database } = fixture();
    try {
      database.saveDictionary({ phrase: "term", replacement: "Term" });
      database.saveTranscription({ text: "example", durationMs: 1, language: null, modelId: "test", status: "complete" });
      const raw = new Database(file);
      raw.exec("create trigger block_reset before delete on dictionary_entries begin select raise(abort,'fixture failure'); end"); raw.close();
      expect(() => database.resetSavedData()).toThrow("fixture failure");
      expect(database.listTranscriptions()).toHaveLength(1);
      expect(database.listDictionary()).toHaveLength(1);
    } finally { database.close(); }
  });
  it("exposes recovery only to the Settings surface", () => {
    for (const channel of [IPC.systemSavedDataStatus, IPC.systemResetSavedData, IPC.systemShowDataBackups]) {
      expect(rendererSurfaceCanInvoke("settings", channel)).toBe(true);
      expect(rendererSurfaceCanInvoke("pill", channel)).toBe(false);
      expect(rendererSurfaceCanInvoke("scratchpad", channel)).toBe(false);
    }
  });
});
