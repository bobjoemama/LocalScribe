import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSquirrelArtifacts,
  inspectSquirrelPayload,
} from "../scripts/squirrel-installer-verifier.mts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "localscribe-squirrel-gate-"));
  temporaryDirectories.push(directory);
  return directory;
}

function storedZip(files: ReadonlyArray<{ name: string; content: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(file.content.length, 18);
    local.writeUInt32LE(file.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, file.content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16);
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

function peWithSquirrelPayload(payload: Buffer): Buffer {
  const peOffset = 0x80;
  const optionalOffset = peOffset + 24;
  const optionalSize = 224;
  const sectionTableOffset = optionalOffset + optionalSize;
  const resourceRawOffset = 0x200;
  const resourceRva = 0x1000;
  const payloadRelativeOffset = 0x100;
  const resourceSize = payloadRelativeOffset + payload.length;
  const rawSize = Math.ceil(resourceSize / 0x200) * 0x200;
  const output = Buffer.alloc(resourceRawOffset + rawSize);

  output.writeUInt16LE(0x5a4d, 0);
  output.writeUInt32LE(peOffset, 0x3c);
  output.writeUInt32LE(0x00004550, peOffset);
  output.writeUInt16LE(0x14c, peOffset + 4);
  output.writeUInt16LE(1, peOffset + 6);
  output.writeUInt16LE(optionalSize, peOffset + 20);
  output.writeUInt16LE(0x10b, optionalOffset);
  output.writeUInt32LE(16, optionalOffset + 92);
  output.writeUInt32LE(resourceRva, optionalOffset + 96 + 2 * 8);
  output.writeUInt32LE(resourceSize, optionalOffset + 96 + 2 * 8 + 4);

  output.write(".rsrc\0\0\0", sectionTableOffset, "ascii");
  output.writeUInt32LE(resourceSize, sectionTableOffset + 8);
  output.writeUInt32LE(resourceRva, sectionTableOffset + 12);
  output.writeUInt32LE(rawSize, sectionTableOffset + 16);
  output.writeUInt32LE(resourceRawOffset, sectionTableOffset + 20);

  const base = resourceRawOffset;
  output.writeUInt16LE(1, base + 12);
  output.writeUInt32LE(0x80000080, base + 16);
  output.writeUInt32LE(0x80000020, base + 20);

  output.writeUInt16LE(1, base + 0x20 + 14);
  output.writeUInt32LE(131, base + 0x20 + 16);
  output.writeUInt32LE(0x80000040, base + 0x20 + 20);

  output.writeUInt16LE(1, base + 0x40 + 14);
  output.writeUInt32LE(1033, base + 0x40 + 16);
  output.writeUInt32LE(0x60, base + 0x40 + 20);

  output.writeUInt32LE(resourceRva + payloadRelativeOffset, base + 0x60);
  output.writeUInt32LE(payload.length, base + 0x64);

  output.writeUInt16LE(4, base + 0x80);
  output.write("DATA", base + 0x82, "utf16le");
  payload.copy(output, base + payloadRelativeOffset);
  return output;
}

function writeArtifactFixture(options?: {
  embeddedNupkg?: Buffer;
  additionalPayloadFiles?: ReadonlyArray<{ name: string; content: Buffer }>;
  additionalReleaseLines?: readonly string[];
}): {
  setupPath: string;
  nupkgPath: string;
  releasesPath: string;
} {
  const directory = temporaryDirectory();
  const nupkgName = "localscribe-0.1.0-full.nupkg";
  const nupkg = Buffer.from("exact emitted LocalScribe package");
  const embeddedNupkg = options?.embeddedNupkg ?? nupkg;
  const releases = Buffer.from(
    [
      `${createHash("sha1").update(nupkg).digest("hex")} ${nupkgName} ${nupkg.length}`,
      ...(options?.additionalReleaseLines ?? []),
      "",
    ].join("\r\n"),
  );
  const payload = storedZip([
    { name: "Update.exe", content: Buffer.alloc(70_000, 0x41) },
    { name: nupkgName, content: embeddedNupkg },
    { name: "RELEASES", content: releases },
    ...(options?.additionalPayloadFiles ?? []),
  ]);
  const setupPath = path.join(directory, "LocalScribe-Setup.exe");
  const nupkgPath = path.join(directory, nupkgName);
  const releasesPath = path.join(directory, "RELEASES");
  writeFileSync(setupPath, peWithSquirrelPayload(payload));
  writeFileSync(nupkgPath, nupkg);
  writeFileSync(releasesPath, releases);
  return { setupPath, nupkgPath, releasesPath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Squirrel Setup.exe embedded-payload gate", () => {
  it("accepts only an installer containing the exact emitted package and RELEASES", async () => {
    const fixture = writeArtifactFixture();
    expect(inspectSquirrelPayload(fixture.setupPath).size).toBeGreaterThan(70_000);
    const result = await assertSquirrelArtifacts(fixture);
    expect(result.embeddedEntries).toEqual([
      "RELEASES",
      "Update.exe",
      "localscribe-0.1.0-full.nupkg",
    ]);
    expect(result.nupkgBytes).toBeGreaterThan(0);
  });

  it("rejects Squirrel's unchanged dummy payload and a substituted embedded package", async () => {
    const fixture = writeArtifactFixture({
      embeddedNupkg: Buffer.from("different package"),
    });
    await expect(assertSquirrelArtifacts(fixture)).rejects.toThrow(
      /does not embed the exact emitted/,
    );

    const vendorSetup = path.resolve(
      "node_modules/electron-winstaller/vendor/Setup.exe",
    );
    mkdirSync(path.dirname(fixture.setupPath), { recursive: true });
    await expect(
      assertSquirrelArtifacts({
        ...fixture,
        setupPath: vendorSetup,
      }),
    ).rejects.toThrow(/must contain exactly the emitted/);
  });

  it("rejects extra RELEASES rows and case-colliding or unexpected payload files", async () => {
    const staleRelease = writeArtifactFixture({
      additionalReleaseLines: [
        `${"a".repeat(40)} localscribe-0.0.9-full.nupkg 123`,
      ],
    });
    await expect(assertSquirrelArtifacts(staleRelease)).rejects.toThrow(
      /exactly one entry/,
    );

    const collision = writeArtifactFixture({
      additionalPayloadFiles: [{ name: "update.exe", content: Buffer.alloc(70_000) }],
    });
    await expect(assertSquirrelArtifacts(collision)).rejects.toThrow(
      /case-insensitive duplicate/,
    );

    const unexpected = writeArtifactFixture({
      additionalPayloadFiles: [{ name: "unexpected.txt", content: Buffer.from("no") }],
    });
    await expect(assertSquirrelArtifacts(unexpected)).rejects.toThrow(
      /payload inventory must be exactly/,
    );
  });
});
