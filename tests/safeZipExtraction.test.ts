import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractVerifiedZip } from "../scripts/safe-zip-extraction.mts";

const temporaryDirectories: string[] = [];

interface StoredEntry {
  name: string;
  content: Buffer;
  versionMadeBy?: number;
  externalFileAttributes?: number;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "localscribe-safe-zip-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function crc32(content: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries: readonly StoredEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const checksum = crc32(entry.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.content.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, entry.content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.versionMadeBy ?? 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.content.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.externalFileAttributes ?? 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + entry.content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function writeZip(root: string, entries: readonly StoredEntry[]): string {
  const zipPath = path.join(root, "fixture.zip");
  writeFileSync(zipPath, storedZip(entries));
  return zipPath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("verified ZIP extraction", () => {
  it("extracts ordinary files only after the whole central directory passes", async () => {
    const root = temporaryDirectory();
    const destination = path.join(root, "output");
    const zipPath = writeZip(root, [
      { name: "LocalScribe.exe", content: Buffer.from("exe") },
      { name: "resources/app.asar", content: Buffer.from("asar") },
    ]);

    await expect(extractVerifiedZip(zipPath, destination)).resolves.toEqual({
      entryCount: 2,
      totalUncompressedBytes: 7,
    });
    expect(readFileSync(path.join(destination, "resources", "app.asar"), "utf8")).toBe("asar");
  });

  it("rejects a symlink before a preceding harmless entry is written", async () => {
    const root = temporaryDirectory();
    const destination = path.join(root, "output");
    const zipPath = writeZip(root, [
      { name: "would-have-been-written.txt", content: Buffer.from("safe") },
      {
        name: "link-outside",
        content: Buffer.from("../outside"),
        versionMadeBy: (3 << 8) | 20,
        externalFileAttributes: (0o120777 << 16) >>> 0,
      },
    ]);

    await expect(extractVerifiedZip(zipPath, destination)).rejects.toThrow(
      /symbolic link/,
    );
    expect(existsSync(path.join(destination, "would-have-been-written.txt"))).toBe(false);
  });

  it.each([
    "../outside.txt",
    "C:/outside.txt",
    "folder\\outside.txt",
    "folder?/outside.txt",
    "NUL.txt",
    "trailing-dot./outside.txt",
  ])("rejects unsafe entry name %j before extraction", async (name) => {
    const root = temporaryDirectory();
    const destination = path.join(root, "output");
    const zipPath = writeZip(root, [
      { name: "would-have-been-written.txt", content: Buffer.from("safe") },
      { name, content: Buffer.from("unsafe") },
    ]);

    await expect(extractVerifiedZip(zipPath, destination)).rejects.toThrow();
    expect(existsSync(path.join(destination, "would-have-been-written.txt"))).toBe(false);
  });

  it("rejects Windows case-collisions before extraction", async () => {
    const root = temporaryDirectory();
    const destination = path.join(root, "output");
    const zipPath = writeZip(root, [
      { name: "Resources/App.asar", content: Buffer.from("one") },
      { name: "resources/app.asar", content: Buffer.from("two") },
    ]);

    await expect(extractVerifiedZip(zipPath, destination)).rejects.toThrow(
      /duplicate or case-colliding entry/,
    );
    expect(existsSync(path.join(destination, "Resources"))).toBe(false);
  });

  it("rejects a child placed beneath a case-insensitive file parent before extraction", async () => {
    const root = temporaryDirectory();
    const destination = path.join(root, "output");
    const zipPath = writeZip(root, [
      { name: "PARENT", content: Buffer.from("file") },
      { name: "parent/child", content: Buffer.from("child") },
    ]);

    await expect(extractVerifiedZip(zipPath, destination)).rejects.toThrow(
      /beneath a file/,
    );
    expect(existsSync(path.join(destination, "PARENT"))).toBe(false);
  });
});
