import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
} from "node:fs";
import path from "node:path";
import { createInflateRaw } from "node:zlib";

const DOS_SIGNATURE = 0x5a4d;
const PE_SIGNATURE = 0x00004550;
const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;
const RESOURCE_DIRECTORY_INDEX = 2;
const RESOURCE_NAME_IS_STRING = 0x80000000;
const RESOURCE_DATA_IS_DIRECTORY = 0x80000000;
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_FILE_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_END_MINIMUM_BYTES = 22;
const ZIP_END_MAXIMUM_SEARCH_BYTES = 65_535 + ZIP_END_MINIMUM_BYTES;
const MAX_RESOURCE_DIRECTORY_ENTRIES = 1_024;
const MAX_EMBEDDED_ZIP_ENTRIES = 32;
const MAX_RESOURCE_NAME_CODE_UNITS = 256;
const MAX_ZIP_NAME_BYTES = 1_024;

interface PeSection {
  virtualAddress: number;
  virtualSize: number;
  rawOffset: number;
  rawSize: number;
}

export interface EmbeddedSquirrelPayload {
  offset: number;
  size: number;
}

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface SquirrelArtifactVerification {
  setupPath: string;
  setupBytes: number;
  payloadBytes: number;
  nupkgPath: string;
  nupkgBytes: number;
  nupkgSha256: string;
  releasesPath: string;
  releasesSha256: string;
  embeddedEntries: readonly string[];
}

function fail(message: string): never {
  throw new Error(`Squirrel installer verification failed: ${message}`);
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) fail(`${label} overflowed`);
  return result;
}

function readExactly(
  descriptor: number,
  offset: number,
  length: number,
  fileSize: number,
  label: string,
): Buffer {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    checkedAdd(offset, length, label) > fileSize
  ) {
    fail(`${label} is outside the installer`);
  }
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const count = readSync(
      descriptor,
      buffer,
      total,
      length - total,
      offset + total,
    );
    if (count === 0) fail(`${label} ended unexpectedly`);
    total += count;
  }
  return buffer;
}

function assertOrdinaryFile(filePath: string, label: string): {
  path: string;
  size: number;
} {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) fail(`${label} is missing: ${resolved}`);
  const metadata = lstatSync(resolved);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail(`${label} must be an ordinary file: ${resolved}`);
  }
  return { path: resolved, size: metadata.size };
}

function rvaToFileOffset(
  rva: number,
  sections: readonly PeSection[],
  fileSize: number,
  label: string,
): number {
  for (const section of sections) {
    const mappedSize = Math.max(section.virtualSize, section.rawSize);
    if (rva < section.virtualAddress || rva >= section.virtualAddress + mappedSize) {
      continue;
    }
    const relative = rva - section.virtualAddress;
    if (relative >= section.rawSize) fail(`${label} points into virtual-only data`);
    const offset = checkedAdd(section.rawOffset, relative, label);
    if (offset >= fileSize) fail(`${label} points outside the installer`);
    return offset;
  }
  fail(`${label} does not map to a PE section`);
}

function resourceDirectoryEntries(
  descriptor: number,
  fileSize: number,
  resourceBase: number,
  resourceSize: number,
  relativeOffset: number,
): Array<{ name: string | number; target: number; directory: boolean }> {
  if (
    relativeOffset < 0 ||
    relativeOffset + 16 > resourceSize
  ) {
    fail("resource directory is outside DATA");
  }
  const header = readExactly(
    descriptor,
    resourceBase + relativeOffset,
    16,
    fileSize,
    "resource directory header",
  );
  const entryCount = header.readUInt16LE(12) + header.readUInt16LE(14);
  if (entryCount > MAX_RESOURCE_DIRECTORY_ENTRIES) {
    fail(`resource directory contains ${entryCount} entries`);
  }
  const entriesBuffer = readExactly(
    descriptor,
    resourceBase + relativeOffset + 16,
    entryCount * 8,
    fileSize,
    "resource directory entries",
  );
  const entries: Array<{ name: string | number; target: number; directory: boolean }> = [];
  for (let index = 0; index < entryCount; index += 1) {
    const offset = index * 8;
    const rawName = entriesBuffer.readUInt32LE(offset);
    const rawTarget = entriesBuffer.readUInt32LE(offset + 4);
    let name: string | number;
    if ((rawName & RESOURCE_NAME_IS_STRING) !== 0) {
      const nameOffset = rawName & ~RESOURCE_NAME_IS_STRING;
      if (nameOffset + 2 > resourceSize) fail("resource name is outside DATA");
      const lengthBuffer = readExactly(
        descriptor,
        resourceBase + nameOffset,
        2,
        fileSize,
        "resource name length",
      );
      const codeUnits = lengthBuffer.readUInt16LE(0);
      if (codeUnits === 0 || codeUnits > MAX_RESOURCE_NAME_CODE_UNITS) {
        fail(`resource name has invalid length ${codeUnits}`);
      }
      if (nameOffset + 2 + codeUnits * 2 > resourceSize) {
        fail("resource name is outside DATA");
      }
      name = readExactly(
        descriptor,
        resourceBase + nameOffset + 2,
        codeUnits * 2,
        fileSize,
        "resource name",
      ).toString("utf16le");
    } else {
      name = rawName;
    }
    entries.push({
      name,
      target: rawTarget & ~RESOURCE_DATA_IS_DIRECTORY,
      directory: (rawTarget & RESOURCE_DATA_IS_DIRECTORY) !== 0,
    });
  }
  return entries;
}

export function inspectSquirrelPayload(setupPath: string): EmbeddedSquirrelPayload {
  const setup = assertOrdinaryFile(setupPath, "Setup.exe");
  const descriptor = openSync(setup.path, "r");
  try {
    const dos = readExactly(descriptor, 0, 64, setup.size, "DOS header");
    if (dos.readUInt16LE(0) !== DOS_SIGNATURE) fail("Setup.exe has no DOS signature");
    const peOffset = dos.readUInt32LE(0x3c);
    const peHeader = readExactly(
      descriptor,
      peOffset,
      24,
      setup.size,
      "PE header",
    );
    if (peHeader.readUInt32LE(0) !== PE_SIGNATURE) {
      fail("Setup.exe has no PE signature");
    }
    const sectionCount = peHeader.readUInt16LE(6);
    const optionalHeaderSize = peHeader.readUInt16LE(20);
    if (sectionCount === 0 || sectionCount > 96) {
      fail(`Setup.exe has invalid PE section count ${sectionCount}`);
    }
    const optionalOffset = peOffset + 24;
    const optional = readExactly(
      descriptor,
      optionalOffset,
      optionalHeaderSize,
      setup.size,
      "PE optional header",
    );
    const magic = optional.readUInt16LE(0);
    const dataDirectoryOffset = magic === PE32_MAGIC
      ? 96
      : magic === PE32_PLUS_MAGIC
        ? 112
        : fail(`Setup.exe has unsupported PE optional-header magic 0x${magic.toString(16)}`);
    const resourceEntryOffset = dataDirectoryOffset + RESOURCE_DIRECTORY_INDEX * 8;
    if (resourceEntryOffset + 8 > optional.length) {
      fail("Setup.exe optional header has no resource directory");
    }
    const resourceRva = optional.readUInt32LE(resourceEntryOffset);
    const resourceSize = optional.readUInt32LE(resourceEntryOffset + 4);
    if (resourceRva === 0 || resourceSize < 64) {
      fail("Setup.exe has no usable resource directory");
    }

    const sectionTableOffset = optionalOffset + optionalHeaderSize;
    const sectionTable = readExactly(
      descriptor,
      sectionTableOffset,
      sectionCount * 40,
      setup.size,
      "PE section table",
    );
    const sections: PeSection[] = [];
    for (let index = 0; index < sectionCount; index += 1) {
      const offset = index * 40;
      sections.push({
        virtualSize: sectionTable.readUInt32LE(offset + 8),
        virtualAddress: sectionTable.readUInt32LE(offset + 12),
        rawSize: sectionTable.readUInt32LE(offset + 16),
        rawOffset: sectionTable.readUInt32LE(offset + 20),
      });
    }
    const resourceBase = rvaToFileOffset(
      resourceRva,
      sections,
      setup.size,
      "resource directory",
    );
    if (resourceBase + resourceSize > setup.size) {
      fail("resource directory extends outside Setup.exe");
    }

    const type = resourceDirectoryEntries(
      descriptor,
      setup.size,
      resourceBase,
      resourceSize,
      0,
    ).find((entry) => entry.name === "DATA");
    if (!type?.directory) fail("Setup.exe has no DATA resource type");
    const payload = resourceDirectoryEntries(
      descriptor,
      setup.size,
      resourceBase,
      resourceSize,
      type.target,
    ).find((entry) => entry.name === 131);
    if (!payload?.directory) fail("Setup.exe has no DATA/#131 payload resource");
    const languages = resourceDirectoryEntries(
      descriptor,
      setup.size,
      resourceBase,
      resourceSize,
      payload.target,
    );
    const language = languages.find((entry) => entry.name === 1033) ?? languages[0];
    if (!language || language.directory) {
      fail("Setup.exe DATA/#131 has no payload language");
    }
    if (language.target + 16 > resourceSize) {
      fail("Setup.exe DATA/#131 data entry is outside the resource directory");
    }
    const dataEntry = readExactly(
      descriptor,
      resourceBase + language.target,
      16,
      setup.size,
      "DATA/#131 data entry",
    );
    const payloadRva = dataEntry.readUInt32LE(0);
    const payloadSize = dataEntry.readUInt32LE(4);
    if (payloadSize < ZIP_END_MINIMUM_BYTES) {
      fail(`Setup.exe DATA/#131 is only ${payloadSize} bytes`);
    }
    const payloadOffset = rvaToFileOffset(
      payloadRva,
      sections,
      setup.size,
      "DATA/#131 payload",
    );
    if (payloadOffset + payloadSize > setup.size) {
      fail("Setup.exe DATA/#131 payload extends outside the installer");
    }
    return { offset: payloadOffset, size: payloadSize };
  } finally {
    closeSync(descriptor);
  }
}

function assertSafeZipName(name: string): void {
  const normalized = name.replaceAll("\\", "/");
  if (
    name.length === 0 ||
    normalized.startsWith("/") ||
    /^[a-z]:\//iu.test(normalized) ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(`embedded payload has unsafe ZIP entry ${JSON.stringify(name)}`);
  }
}

function zipEntries(
  setupPath: string,
  setupSize: number,
  payload: EmbeddedSquirrelPayload,
): ZipEntry[] {
  const descriptor = openSync(setupPath, "r");
  try {
    const tailLength = Math.min(payload.size, ZIP_END_MAXIMUM_SEARCH_BYTES);
    const tail = readExactly(
      descriptor,
      payload.offset + payload.size - tailLength,
      tailLength,
      setupSize,
      "embedded ZIP tail",
    );
    let endOffset = -1;
    for (let index = tail.length - ZIP_END_MINIMUM_BYTES; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) !== ZIP_END_SIGNATURE) continue;
      const commentBytes = tail.readUInt16LE(index + 20);
      if (index + ZIP_END_MINIMUM_BYTES + commentBytes === tail.length) {
        endOffset = index;
        break;
      }
    }
    if (endOffset < 0) fail("DATA/#131 is not a complete ZIP archive");
    const diskNumber = tail.readUInt16LE(endOffset + 4);
    const centralDisk = tail.readUInt16LE(endOffset + 6);
    const diskEntries = tail.readUInt16LE(endOffset + 8);
    const totalEntries = tail.readUInt16LE(endOffset + 10);
    const centralSize = tail.readUInt32LE(endOffset + 12);
    const centralOffset = tail.readUInt32LE(endOffset + 16);
    if (
      diskNumber !== 0 ||
      centralDisk !== 0 ||
      diskEntries !== totalEntries ||
      totalEntries === 0 ||
      totalEntries > MAX_EMBEDDED_ZIP_ENTRIES ||
      totalEntries === 0xffff ||
      centralSize === 0xffffffff ||
      centralOffset === 0xffffffff
    ) {
      fail("embedded payload uses an unsupported split, empty, oversized, or ZIP64 directory");
    }
    if (centralOffset + centralSize > payload.size) {
      fail("embedded ZIP central directory is outside DATA/#131");
    }

    const entries: ZipEntry[] = [];
    const seenNames = new Set<string>();
    let cursor = payload.offset + centralOffset;
    const centralEnd = cursor + centralSize;
    for (let index = 0; index < totalEntries; index += 1) {
      const fixed = readExactly(
        descriptor,
        cursor,
        46,
        setupSize,
        "embedded ZIP central entry",
      );
      if (fixed.readUInt32LE(0) !== ZIP_CENTRAL_FILE_SIGNATURE) {
        fail("embedded ZIP has an invalid central entry");
      }
      const flags = fixed.readUInt16LE(8);
      const method = fixed.readUInt16LE(10);
      const compressedSize = fixed.readUInt32LE(20);
      const uncompressedSize = fixed.readUInt32LE(24);
      const nameLength = fixed.readUInt16LE(28);
      const extraLength = fixed.readUInt16LE(30);
      const commentLength = fixed.readUInt16LE(32);
      const localHeaderOffset = fixed.readUInt32LE(42);
      if (
        nameLength === 0 ||
        nameLength > MAX_ZIP_NAME_BYTES ||
        compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff ||
        localHeaderOffset === 0xffffffff
      ) {
        fail("embedded ZIP entry has unsupported ZIP64 or invalid metadata");
      }
      if ((flags & 0x1) !== 0 || (method !== 0 && method !== 8)) {
        fail("embedded ZIP entry is encrypted or uses an unsupported compression method");
      }
      const variableLength = nameLength + extraLength + commentLength;
      const variable = readExactly(
        descriptor,
        cursor + 46,
        variableLength,
        setupSize,
        "embedded ZIP central entry metadata",
      );
      const name = variable.subarray(0, nameLength).toString("utf8");
      assertSafeZipName(name);
      const canonicalName = name.toLowerCase();
      if (seenNames.has(canonicalName)) {
        fail(`embedded ZIP contains a case-insensitive duplicate entry ${name}`);
      }
      seenNames.add(canonicalName);
      entries.push({
        name,
        flags,
        method,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
      cursor += 46 + variableLength;
    }
    if (cursor !== centralEnd) fail("embedded ZIP central directory size is inconsistent");
    return entries;
  } finally {
    closeSync(descriptor);
  }
}

async function hashEmbeddedZipEntry(
  setupPath: string,
  setupSize: number,
  payload: EmbeddedSquirrelPayload,
  entry: ZipEntry,
  algorithm: "sha1" | "sha256",
): Promise<{ digest: string; bytes: number }> {
  const descriptor = openSync(setupPath, "r");
  let dataOffset: number;
  try {
    const localOffset = payload.offset + entry.localHeaderOffset;
    const local = readExactly(
      descriptor,
      localOffset,
      30,
      setupSize,
      `local ZIP header for ${entry.name}`,
    );
    if (local.readUInt32LE(0) !== ZIP_LOCAL_FILE_SIGNATURE) {
      fail(`embedded ZIP local header is invalid for ${entry.name}`);
    }
    if (
      local.readUInt16LE(6) !== entry.flags ||
      local.readUInt16LE(8) !== entry.method
    ) {
      fail(`embedded ZIP central/local metadata disagree for ${entry.name}`);
    }
    const nameLength = local.readUInt16LE(26);
    const extraLength = local.readUInt16LE(28);
    if (nameLength === 0 || nameLength > MAX_ZIP_NAME_BYTES) {
      fail(`embedded ZIP local name is invalid for ${entry.name}`);
    }
    const localName = readExactly(
      descriptor,
      localOffset + 30,
      nameLength,
      setupSize,
      `local ZIP name for ${entry.name}`,
    ).toString("utf8");
    if (localName !== entry.name) {
      fail(`embedded ZIP central/local names disagree for ${entry.name}`);
    }
    dataOffset = localOffset + 30 + nameLength + extraLength;
    if (dataOffset + entry.compressedSize > payload.offset + payload.size) {
      fail(`embedded ZIP data is outside DATA/#131 for ${entry.name}`);
    }
  } finally {
    closeSync(descriptor);
  }

  const compressed = createReadStream(setupPath, {
    start: dataOffset,
    end: dataOffset + entry.compressedSize - 1,
  });
  const content = entry.method === 8 ? compressed.pipe(createInflateRaw()) : compressed;
  const digest = createHash(algorithm);
  let bytes = 0;
  for await (const chunk of content) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (!Number.isSafeInteger(bytes) || bytes > entry.uncompressedSize) {
      fail(`embedded ZIP entry expanded beyond its declared size: ${entry.name}`);
    }
    digest.update(data);
  }
  if (bytes !== entry.uncompressedSize) {
    fail(`embedded ZIP entry size is wrong for ${entry.name}`);
  }
  return { digest: digest.digest("hex"), bytes };
}

async function hashFile(
  filePath: string,
  algorithm: "sha1" | "sha256",
): Promise<string> {
  const digest = createHash(algorithm);
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

function releaseEntryFor(
  releasesPath: string,
  nupkgName: string,
): { sha1: string; size: number } {
  const lines = readFileSync(releasesPath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = lines.map((line) => {
    const match = /^([a-f0-9]{40})\s+(\S+)\s+([0-9]+)$/iu.exec(line);
    if (!match?.[1] || !match[2] || !match[3]) {
      fail(`RELEASES contains a malformed entry: ${JSON.stringify(line)}`);
    }
    return {
      sha1: match[1].toLowerCase(),
      filename: match[2],
      size: Number(match[3]),
    };
  });
  if (
    parsed.length !== 1 ||
    parsed[0]?.filename !== nupkgName ||
    !Number.isSafeInteger(parsed[0]?.size)
  ) {
    fail(`RELEASES must contain exactly one entry and it must be ${nupkgName}`);
  }
  return { sha1: parsed[0].sha1, size: parsed[0].size };
}

export async function assertSquirrelArtifacts(options: {
  setupPath: string;
  nupkgPath: string;
  releasesPath: string;
}): Promise<SquirrelArtifactVerification> {
  const setup = assertOrdinaryFile(options.setupPath, "Setup.exe");
  const nupkg = assertOrdinaryFile(options.nupkgPath, ".nupkg");
  const releases = assertOrdinaryFile(options.releasesPath, "RELEASES");
  const nupkgName = path.basename(nupkg.path);
  const payload = inspectSquirrelPayload(setup.path);
  const entries = zipEntries(setup.path, setup.size, payload);
  const byName = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry]));
  const embeddedPackages = entries.filter((entry) =>
    entry.name.toLowerCase().endsWith(".nupkg")
  );
  const embeddedNupkg = byName.get(nupkgName.toLowerCase());
  const embeddedReleases = byName.get("releases");
  const embeddedUpdate = byName.get("update.exe");
  if (embeddedPackages.length !== 1 || !embeddedNupkg) {
    fail(
      `DATA/#131 must contain exactly the emitted ${nupkgName}; found ` +
      `[${embeddedPackages.map((entry) => entry.name).join(", ")}]`,
    );
  }
  if (!embeddedReleases || !embeddedUpdate || embeddedUpdate.uncompressedSize < 64 * 1024) {
    fail("DATA/#131 must contain RELEASES and a non-placeholder Update.exe");
  }
  const expectedEntryNames = new Set([
    "update.exe",
    "releases",
    nupkgName.toLowerCase(),
  ]);
  const unexpectedEntries = entries.filter(
    (entry) => !expectedEntryNames.has(entry.name.toLowerCase()),
  );
  if (entries.length !== expectedEntryNames.size || unexpectedEntries.length > 0) {
    fail(
      "DATA/#131 payload inventory must be exactly Update.exe, RELEASES, and " +
      `${nupkgName}; unexpected entries: ` +
      `[${unexpectedEntries.map((entry) => entry.name).join(", ")}]`,
    );
  }

  const releaseEntry = releaseEntryFor(releases.path, nupkgName);
  if (releaseEntry.size !== nupkg.size) {
    fail(`RELEASES size for ${nupkgName} is ${releaseEntry.size}, expected ${nupkg.size}`);
  }
  const [nupkgSha1, nupkgSha256, releasesSha256, embeddedNupkgSha256, embeddedReleasesSha256] =
    await Promise.all([
      hashFile(nupkg.path, "sha1"),
      hashFile(nupkg.path, "sha256"),
      hashFile(releases.path, "sha256"),
      hashEmbeddedZipEntry(setup.path, setup.size, payload, embeddedNupkg, "sha256"),
      hashEmbeddedZipEntry(setup.path, setup.size, payload, embeddedReleases, "sha256"),
    ]);
  if (releaseEntry.sha1 !== nupkgSha1) {
    fail(`RELEASES SHA-1 for ${nupkgName} does not match the emitted package`);
  }
  if (
    embeddedNupkgSha256.bytes !== nupkg.size ||
    embeddedNupkgSha256.digest !== nupkgSha256
  ) {
    fail(`Setup.exe does not embed the exact emitted ${nupkgName}`);
  }
  if (
    embeddedReleasesSha256.bytes !== releases.size ||
    embeddedReleasesSha256.digest !== releasesSha256
  ) {
    fail("Setup.exe does not embed the exact emitted RELEASES file");
  }

  return {
    setupPath: setup.path,
    setupBytes: setup.size,
    payloadBytes: payload.size,
    nupkgPath: nupkg.path,
    nupkgBytes: nupkg.size,
    nupkgSha256,
    releasesPath: releases.path,
    releasesSha256,
    embeddedEntries: entries.map((entry) => entry.name).sort(),
  };
}
