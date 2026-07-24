import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
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
const openDatabases: LocalDatabase[] = [];
const posixIt = process.platform === "win32" ? it.skip : it;

function createTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function mode(targetPath: string): number {
  return statSync(targetPath).mode & 0o777;
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database filesystem permission hardening", () => {
  posixIt("sets a new database directory and SQLite files to user-only modes", () => {
    const directory = createTemporaryDirectory("localscribe-permissions-test-");
    chmodSync(directory, 0o777);
    const databasePath = path.join(directory, "test.db");

    const database = new LocalDatabase(databasePath);
    openDatabases.push(database);

    expect(mode(directory)).toBe(0o700);
    for (const filePath of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      expect(existsSync(filePath)).toBe(true);
      expect(mode(filePath)).toBe(0o600);
    }
  });

  posixIt("does not follow a symlink to chmod an unsafe parent directory", () => {
    const container = createTemporaryDirectory("localscribe-permissions-link-test-");
    const targetDirectory = createTemporaryDirectory("localscribe-permissions-target-test-");
    chmodSync(targetDirectory, 0o777);
    const linkedDirectory = path.join(container, "database-parent");
    symlinkSync(targetDirectory, linkedDirectory, "dir");

    const database = new LocalDatabase(path.join(linkedDirectory, "test.db"));
    openDatabases.push(database);

    expect(mode(targetDirectory)).toBe(0o777);
  });

  posixIt("preserves in-memory first-run behavior without touching a filesystem parent", () => {
    const database = new LocalDatabase(":memory:");
    openDatabases.push(database);

    expect(database.integrityCheck()).toBe("ok");
  });
});
