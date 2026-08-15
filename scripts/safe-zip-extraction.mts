import { createWriteStream, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";

/*
 * Archives checked here are build artifacts, not application input.  They are
 * nevertheless parsed as hostile data: a compromised build output must not be
 * able to create links or write outside the verifier's private directory.
 *
 * Keep the limits above the largest currently supported Windows artifact while
 * bounding resource use if a malformed archive lies about its contents.
 */
const MAX_ENTRY_COUNT = 50_000;
const MAX_ENTRY_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_DIRECTORY_TYPE = 0o040000;
const UNIX_REGULAR_FILE_TYPE = 0o100000;
const UNIX_SYMLINK_TYPE = 0o120000;
const WINDOWS_RESERVED_COMPONENT = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;
const WINDOWS_FORBIDDEN_COMPONENT_CHARACTER = /[<>:"\\|?*]/u;

export interface VerifiedZipExtraction {
  entryCount: number;
  totalUncompressedBytes: number;
}

interface CheckedEntry {
  entry: yauzl.Entry;
  relativePath: string;
  directory: boolean;
}

function fail(message: string): never {
  throw new Error(`unsafe ZIP rejected before extraction: ${message}`);
}

function closeQuietly(zip: yauzl.ZipFile): void {
  if (zip.isOpen) zip.close();
}

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      zipPath,
      {
        autoClose: false,
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, zip) => {
        if (error || !zip) reject(error ?? new Error("ZIP reader did not return an archive"));
        else resolve(zip);
      },
    );
  });
}

function entryIsDirectory(entry: yauzl.Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const unixType = mode & UNIX_FILE_TYPE_MASK;
  if (unixType === UNIX_DIRECTORY_TYPE) return true;
  if (entry.fileName.endsWith("/")) return true;

  // MS-DOS directory bit, used by archives made on Windows without POSIX mode.
  const madeBy = entry.versionMadeBy >>> 8;
  return madeBy === 0 && entry.externalFileAttributes === 16;
}

function windowsPathKey(relativePath: string): string {
  return relativePath.normalize("NFC").toLocaleLowerCase("en-US");
}

function hasWindowsForbiddenCharacter(component: string): boolean {
  return (
    WINDOWS_FORBIDDEN_COMPONENT_CHARACTER.test(component) ||
    [...component].some((character) => character.codePointAt(0)! < 0x20)
  );
}

function checkedRelativePath(entry: yauzl.Entry): { relativePath: string; directory: boolean } {
  const rawName = entry.fileName;
  if (rawName.length === 0 || rawName.includes("\0")) {
    fail("entry has an empty or NUL-containing name");
  }
  if (rawName.includes("\\") || rawName.startsWith("/") || /^[A-Za-z]:/u.test(rawName)) {
    fail(`entry has an absolute or Windows-ambiguous path: ${JSON.stringify(rawName)}`);
  }

  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const unixType = mode & UNIX_FILE_TYPE_MASK;
  if (unixType === UNIX_SYMLINK_TYPE) {
    fail(`entry is a symbolic link: ${JSON.stringify(rawName)}`);
  }
  if (
    unixType !== 0 &&
    unixType !== UNIX_DIRECTORY_TYPE &&
    unixType !== UNIX_REGULAR_FILE_TYPE
  ) {
    fail(`entry has an unsupported POSIX file type: ${JSON.stringify(rawName)}`);
  }

  const directory = entryIsDirectory(entry);
  const components = rawName.split("/");
  if (directory && components.at(-1) === "") components.pop();
  if (components.length === 0 || components.some((component) => component.length === 0)) {
    fail(`entry has an empty path component: ${JSON.stringify(rawName)}`);
  }
  for (const component of components) {
    if (
      component === "." ||
      component === ".." ||
      component.includes(":") ||
      component.endsWith(".") ||
      component.endsWith(" ") ||
      hasWindowsForbiddenCharacter(component) ||
      WINDOWS_RESERVED_COMPONENT.test(component)
    ) {
      fail(`entry has an unsafe Windows path component: ${JSON.stringify(rawName)}`);
    }
  }
  return { relativePath: components.join("/"), directory };
}

function readAllEntries(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: yauzl.Entry[] = [];
    let settled = false;
    const failRead = (error: Error): void => {
      if (settled) return;
      settled = true;
      closeQuietly(zip);
      reject(error);
    };
    zip.once("error", failRead);
    zip.on("entry", (entry: yauzl.Entry) => {
      if (settled) return;
      entries.push(entry);
      zip.readEntry();
    });
    zip.once("end", () => {
      if (settled) return;
      settled = true;
      resolve(entries);
    });
    zip.readEntry();
  });
}

function preflight(entries: readonly yauzl.Entry[]): {
  entries: CheckedEntry[];
  totalUncompressedBytes: number;
} {
  if (entries.length === 0) fail("archive has no entries");
  if (entries.length > MAX_ENTRY_COUNT) fail(`archive has too many entries: ${entries.length}`);

  const seen = new Map<string, CheckedEntry>();
  let totalUncompressedBytes = 0;
  const checked = entries.map((entry) => {
    if (entry.isEncrypted()) fail(`entry is encrypted: ${JSON.stringify(entry.fileName)}`);
    if (
      !Number.isSafeInteger(entry.uncompressedSize) ||
      entry.uncompressedSize < 0 ||
      entry.uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES
    ) {
      fail(`entry has an unsafe declared size: ${JSON.stringify(entry.fileName)}`);
    }
    totalUncompressedBytes += entry.uncompressedSize;
    if (!Number.isSafeInteger(totalUncompressedBytes) || totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      fail("archive expands beyond the verified extraction limit");
    }

    const { relativePath, directory } = checkedRelativePath(entry);
    const key = windowsPathKey(relativePath);
    if (seen.has(key)) fail(`archive has a duplicate or case-colliding entry: ${JSON.stringify(relativePath)}`);
    const checkedEntry = { entry, relativePath, directory };
    seen.set(key, checkedEntry);
    return checkedEntry;
  });

  const files = new Set(
    checked
      .filter((entry) => !entry.directory)
      .map((entry) => windowsPathKey(entry.relativePath)),
  );
  for (const entry of checked) {
    const components = entry.relativePath.split("/");
    for (let index = 1; index < components.length; index += 1) {
      const parent = windowsPathKey(components.slice(0, index).join("/"));
      if (files.has(parent)) {
        fail(`archive places an entry beneath a file: ${JSON.stringify(entry.relativePath)}`);
      }
    }
  }
  return { entries: checked, totalUncompressedBytes };
}

function ensureDirectory(directory: string, root: string): void {
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`destination escaped its extraction root: ${directory}`);
  }
  let current = root;
  for (const component of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, component);
    try {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        fail(`destination parent is not an ordinary directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
    }
  }
}

function openEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error(`could not read ${entry.fileName}`));
      else resolve(stream);
    });
  });
}

/**
 * Validates every central-directory entry before creating an output path, then
 * extracts only ordinary files/directories into an existing private root.
 */
export async function extractVerifiedZip(
  zipPath: string,
  destination: string,
): Promise<VerifiedZipExtraction> {
  const resolvedDestination = path.resolve(destination);
  let rootMetadata: ReturnType<typeof lstatSync>;
  try {
    rootMetadata = lstatSync(resolvedDestination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      mkdirSync(resolvedDestination, { mode: 0o700, recursive: true });
      rootMetadata = lstatSync(resolvedDestination);
    } else {
      throw error;
    }
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    fail(`destination is not an ordinary directory: ${resolvedDestination}`);
  }

  const zip = await openZip(path.resolve(zipPath));
  try {
    const initialEntries = await readAllEntries(zip);
    const verified = preflight(initialEntries);

    for (const checked of verified.entries) {
      const destinationPath = path.join(
        resolvedDestination,
        ...checked.relativePath.split("/"),
      );
      if (checked.directory) {
        ensureDirectory(destinationPath, resolvedDestination);
        continue;
      }
      ensureDirectory(path.dirname(destinationPath), resolvedDestination);
      const readStream = await openEntryStream(zip, checked.entry);
      const writeStream = createWriteStream(destinationPath, {
        flags: "wx",
        mode: 0o600,
      });
      await pipeline(readStream, writeStream);
      if (writeStream.bytesWritten !== checked.entry.uncompressedSize) {
        fail(`entry changed while extracting: ${JSON.stringify(checked.relativePath)}`);
      }
      const metadata = lstatSync(destinationPath);
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== checked.entry.uncompressedSize) {
        fail(`entry did not extract as an ordinary expected file: ${JSON.stringify(checked.relativePath)}`);
      }
    }
    return {
      entryCount: verified.entries.length,
      totalUncompressedBytes: verified.totalUncompressedBytes,
    };
  } finally {
    closeQuietly(zip);
  }
}
