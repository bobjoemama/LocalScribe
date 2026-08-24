import { readFileSync } from "node:fs";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expectPrecedes, sliceBetween, sliceFollowing } from "./support/order";

/*
 * The macOS application menu is rebuilt from `setSession`, which runs on every
 * session transition — listening, finalizing, transcribing, inserting, success,
 * idle — so six times per dictation, on the same thread that is inserting text
 * into whatever app the user is typing in.
 *
 * It needs three facts: two counts and whether a transcript exists. It was
 * getting them by listing the tables, which decrypts every snippet expansion
 * and one transcript through safeStorage. Nothing about a count requires
 * plaintext.
 *
 * `decryptString` is counted rather than timed: the cost of a keychain-backed
 * decrypt is not this suite's to measure, but "how many times is it called"
 * is exactly the thing that regressed.
 */

let decryptCalls = 0;

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) =>
      Buffer.from(`cipher:${Buffer.from(value, "utf8").toString("base64")}`),
    decryptString: (value: Buffer) => {
      decryptCalls += 1;
      return Buffer.from(
        value.toString("utf8").replace(/^cipher:/u, ""),
        "base64",
      ).toString("utf8");
    },
  },
}));

const { LocalDatabase } = await import("../src/main/persistence/database");

const directories: string[] = [];

function database() {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "localscribe-menu-reads-"));
  directories.push(directory);
  const db = new LocalDatabase(path.join(directory, "test.db"));
  for (let index = 0; index < 12; index += 1) {
    db.saveSnippet({ trigger: `trigger${index}`, expansion: `expansion ${index}` });
    db.saveDictionary({ phrase: `phrase${index}`, replacement: `replacement ${index}` });
    db.saveTranscription({
      durationMs: 1_000,
      text: `transcript ${index}`,
      language: "en",
      modelId: "whisper-large-v3-turbo",
      status: "complete",
      sourceAppId: null,
    });
  }
  return db;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("reading what the menu displays", () => {
  it("counts snippets without decrypting a single one", () => {
    const db = database();
    decryptCalls = 0;

    expect(db.countSnippets()).toBe(12);

    expect(decryptCalls).toBe(0);
    db.close();
  });

  it("counts dictionary entries without reading their contents", () => {
    const db = database();
    decryptCalls = 0;

    expect(db.countDictionary()).toBe(12);

    expect(decryptCalls).toBe(0);
    db.close();
  });

  it("answers whether a transcript exists without decrypting one", () => {
    const db = database();
    decryptCalls = 0;

    expect(db.hasTranscriptions()).toBe(true);

    expect(decryptCalls).toBe(0);
    db.close();
  });

  it("reports no transcripts on a fresh install", () => {
    const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "localscribe-menu-reads-"));
    directories.push(directory);
    const db = new LocalDatabase(path.join(directory, "empty.db"));

    expect(db.hasTranscriptions()).toBe(false);
    expect(db.countSnippets()).toBe(0);
    expect(db.countDictionary()).toBe(0);
    db.close();
  });

  it("tracks the tables as they change", () => {
    const db = database();

    db.deleteSnippet(db.listSnippets()[0]!.id);
    expect(db.countSnippets()).toBe(11);

    db.saveDictionary({ phrase: "another", replacement: "one" });
    expect(db.countDictionary()).toBe(13);
    db.close();
  });

  /*
   * `listSnippets` drops a row it cannot decrypt, so on a machine whose
   * keychain entry was rotated the old menu quietly under-reported. Counting
   * rows is the more truthful answer to "how many snippets do I have".
   */
  it("counts a snippet this install can no longer read", () => {
    const db = database();
    const before = db.countSnippets();

    // Corrupt one stored blob directly, the way a rotated key presents.
    (db as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db
      .prepare("UPDATE snippets SET expansion_encrypted = ? WHERE id = (SELECT id FROM snippets LIMIT 1)")
      .run(Buffer.from("not-decryptable"));

    expect(db.countSnippets()).toBe(before);
    db.close();
  });
});

describe("what building the menu is allowed to do", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const menu = sliceBetween(
    main,
    "function installApplicationMenu(): void {",
    "Menu.setApplicationMenu(",
    "src/main.ts",
  );

  it("uses the counting reads rather than listing the tables", () => {
    expect(menu).toContain("database.countDictionary()");
    expect(menu).toContain("database.countSnippets()");
    expect(menu).toContain("database.hasTranscriptions()");
    expect(menu).not.toContain("database.listDictionary()");
    expect(menu).not.toContain("database.listSnippets()");
  });

  it("keeps the transcript read inside the click handler", () => {
    // `latest()` still exists — Copy Last Transcript needs the text — but it
    // must only run when the item is actually chosen.
    // `click:` appears on earlier items too, so take the one that follows.
    const enabled = sliceFollowing(menu, '"Copy Last Transcript"', "click:", "the menu");

    expect(enabled).not.toContain("latest()");
  });
});

describe("refreshing My Voice after a library mutation", () => {
  const main = readFileSync("src/main.ts", "utf8");

  it.each([
    ["dictionary save", "handle(IPC.dictionarySave", "handle(IPC.dictionaryDelete", "database.saveDictionary", "refreshVoiceMenuAfterLibraryMutation"],
    ["dictionary delete", "handle(IPC.dictionaryDelete", "handle(IPC.snippetsList", "database.deleteDictionary", "refreshVoiceMenuAfterLibraryMutation"],
    ["snippet save", "handle(IPC.snippetsSave", "handle(IPC.snippetsDelete", "database.saveSnippet", "refreshVoiceMenuAfterLibraryMutation"],
    ["snippet delete", "handle(IPC.snippetsDelete", "handle(IPC.profilesList", "database.deleteSnippet", "refreshVoiceMenuAfterLibraryMutation"],
  ])("rebuilds the native menu immediately after %s", (_name, start, end, mutation, refresh) => {
    const handler = sliceBetween(main, start, end, "src/main.ts");

    expectPrecedes(handler, mutation, refresh, start);
  });

  it("treats a native-menu refresh as best effort after the durable mutation", () => {
    const refresh = sliceBetween(
      main,
      "function refreshVoiceMenuAfterLibraryMutation(): void {",
      "/** Broadcast only validated, persisted settings",
      "src/main.ts",
    );

    expect(refresh).toContain("installApplicationMenu()");
    expect(refresh).toContain("catch (error)");
  });
});
