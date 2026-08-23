import { mkdtempSync, rmSync } from "node:fs";
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
  const directory = mkdtempSync(path.join(tmpdir(), "localscribe-profile-test-"));
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
});
