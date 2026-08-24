import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
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
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), prefix));
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

  posixIt("rejects a pre-created intermediate directory symlink before SQLite opens", () => {
    const container = createTemporaryDirectory("localscribe-permissions-link-test-");
    const targetDirectory = createTemporaryDirectory("localscribe-permissions-target-test-");
    chmodSync(targetDirectory, 0o777);
    const linkedDirectory = path.join(container, "database-parent");
    symlinkSync(targetDirectory, linkedDirectory, "dir");

    expect(() => new LocalDatabase(path.join(linkedDirectory, "test.db")))
      .toThrow(/parent component is a symbolic link/u);

    expect(mode(targetDirectory)).toBe(0o777);
    expect(existsSync(path.join(targetDirectory, "test.db"))).toBe(false);
  });

  posixIt("rejects a pre-created final database symlink before SQLite opens", () => {
    const container = createTemporaryDirectory("localscribe-permissions-file-link-test-");
    const targetDirectory = createTemporaryDirectory("localscribe-permissions-file-target-test-");
    const targetPath = path.join(targetDirectory, "target.db");
    const target = new LocalDatabase(targetPath);
    target.close();
    chmodSync(targetPath, 0o644);
    const linkedDatabase = path.join(container, "test.db");
    symlinkSync(targetPath, linkedDatabase, "file");

    expect(() => new LocalDatabase(linkedDatabase))
      .toThrow(/database file is a symbolic link/u);
    expect(mode(targetPath)).toBe(0o644);
  });

  posixIt("creates only the missing direct parent with a private mode", () => {
    const container = createTemporaryDirectory("localscribe-permissions-create-parent-test-");
    const parent = path.join(container, "database-parent");
    const database = new LocalDatabase(path.join(parent, "test.db"));
    openDatabases.push(database);

    expect(mode(parent)).toBe(0o700);
    expect(database.integrityCheck()).toBe("ok");
  });

  posixIt("preserves in-memory first-run behavior without touching a filesystem parent", () => {
    const database = new LocalDatabase(":memory:");
    openDatabases.push(database);

    expect(database.integrityCheck()).toBe("ok");
  });
});
