import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertWindowsPortableArtifact } from "../scripts/windows-portable-verifier.mts";

const temporaryDirectories: string[] = [];

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

function storedZip(files: ReadonlyArray<{ name: string; content: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const checksum = crc32(file.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(file.content.length, 18);
    local.writeUInt32LE(file.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, file.content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(file.content.length, 20);
    central.writeUInt32LE(file.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + file.content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "localscribe-portable-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Windows portable artifact verifier", () => {
  it("accepts an exact archive and rejects a changed archive tree", async () => {
    const root = temporaryDirectory();
    const staged = path.join(root, "LocalScribe-win32-x64");
    const resources = path.join(staged, "resources");
    mkdirSync(resources, { recursive: true });
    writeFileSync(path.join(staged, "LocalScribe.exe"), "exe");
    writeFileSync(path.join(resources, "app.asar"), "asar");
    const zipPath = path.join(root, "LocalScribe-win32-x64-0.1.0.zip");
    writeFileSync(zipPath, storedZip([
      { name: "LocalScribe.exe", content: Buffer.from("exe") },
      { name: "resources/app.asar", content: Buffer.from("asar") },
    ]));

    await expect(assertWindowsPortableArtifact({
      stagedDirectory: staged,
      zipPath,
      verifyPackagedArchive: false,
    })).resolves.toMatchObject({ fileCount: 2 });

    writeFileSync(path.join(resources, "added-after-zip.txt"), "not in zip");
    await expect(assertWindowsPortableArtifact({
      stagedDirectory: staged,
      zipPath,
      verifyPackagedArchive: false,
    })).rejects.toThrow(/not an exact byte-for-byte copy/);
  });
});
