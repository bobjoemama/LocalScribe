import yauzl, { type Entry, type ZipFile } from "yauzl";
import path from "node:path";

const UNIX_HOST = 3;
const FILE_TYPE_MASK = 0o170000;
const REGULAR_FILE = 0o100000;
const DIRECTORY = 0o040000;
const SYMBOLIC_LINK = 0o120000;
const FORBIDDEN_PERMISSION_BITS = 0o6022;
const MAX_ENTRIES = 200_000;
const MAX_EXPANDED_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_LINK_BYTES = 4 * 1024;
const MAX_SYMLINK_RESOLUTIONS = 64;

type ArchiveEntry = {
  readonly entry: Entry;
  readonly relativePath: string;
  readonly type: number;
};

function fail(message: string): never {
  throw new Error(`unsafe macOS application ZIP rejected before extraction: ${message}`);
}

function canonicalEntryPath(fileName: string): string {
  if (
    fileName.length === 0 ||
    fileName.includes("\0") ||
    fileName.includes("\\") ||
    fileName.startsWith("/")
  ) {
    fail(`invalid entry path ${JSON.stringify(fileName)}`);
  }
  const withoutDirectorySlash = fileName.endsWith("/") ? fileName.slice(0, -1) : fileName;
  const segments = withoutDirectorySlash.split("/");
  if (
    withoutDirectorySlash.length === 0 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(`non-canonical entry path ${JSON.stringify(fileName)}`);
  }
  const normalized = path.posix.normalize(withoutDirectorySlash);
  if (normalized !== withoutDirectorySlash) {
    fail(`non-canonical entry path ${JSON.stringify(fileName)}`);
  }
  return normalized;
}

function openZip(zipPath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, {
      lazyEntries: true,
      decodeStrings: true,
      strictFileNames: true,
      validateEntrySizes: true,
      autoClose: false,
    }, (error, zipFile) => {
      if (error) reject(error);
      else if (!zipFile) reject(new Error("ZIP reader returned no archive"));
      else resolve(zipFile);
    });
  });
}

function readEntry(zipFile: ZipFile, entry: Entry, maximumBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      if (!stream) {
        reject(new Error("ZIP reader returned no entry stream"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maximumBytes) {
          stream.destroy(new Error("entry exceeds its preflight byte limit"));
          return;
        }
        chunks.push(chunk);
      });
      stream.once("error", reject);
      stream.once("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

function targetExists(target: string, paths: ReadonlySet<string>): boolean {
  if (paths.has(target)) return true;
  const prefix = `${target}/`;
  for (const candidate of paths) {
    if (candidate.startsWith(prefix)) return true;
  }
  return false;
}

function foldedArchivePath(archivePath: string): string {
  return archivePath.normalize("NFC").toLocaleLowerCase("en-US");
}

function normalizedLinkTarget(linkPath: string, rawTarget: string, applicationName: string): string {
  if (
    rawTarget.length === 0 ||
    rawTarget.includes("\0") ||
    rawTarget.includes("\\") ||
    path.posix.isAbsolute(rawTarget)
  ) {
    fail(`${linkPath} has an invalid symlink target`);
  }
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(linkPath), rawTarget));
  if (target !== applicationName && !target.startsWith(`${applicationName}/`)) {
    fail(`${linkPath} escapes the application bundle`);
  }
  return target;
}

function resolveArchiveSymlink(
  linkPath: string,
  applicationName: string,
  exactPaths: ReadonlySet<string>,
  typesByCaseFoldedPath: ReadonlyMap<string, number>,
  linksByCaseFoldedPath: ReadonlyMap<string, { readonly path: string; readonly target: string }>,
): string {
  const initial = linksByCaseFoldedPath.get(foldedArchivePath(linkPath));
  if (!initial) fail(`${linkPath} has no inspected symlink payload`);
  let candidate = normalizedLinkTarget(initial.path, initial.target, applicationName);
  const visitedLinks = new Set<string>([foldedArchivePath(linkPath)]);
  for (let resolutions = 0; resolutions <= MAX_SYMLINK_RESOLUTIONS; resolutions += 1) {
    const segments = candidate.split("/");
    let followedLink = false;
    for (let index = 0; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index + 1).join("/");
      const foldedPrefix = foldedArchivePath(prefix);
      const type = typesByCaseFoldedPath.get(foldedPrefix);
      if (type === SYMBOLIC_LINK) {
        if (visitedLinks.has(foldedPrefix)) fail(`${linkPath} resolves through a symlink cycle`);
        visitedLinks.add(foldedPrefix);
        const link = linksByCaseFoldedPath.get(foldedPrefix);
        if (!link) fail(`${prefix} has no inspected symlink payload`);
        const linkTarget = normalizedLinkTarget(link.path, link.target, applicationName);
        const remainder = segments.slice(index + 1).join("/");
        candidate = remainder ? path.posix.normalize(path.posix.join(linkTarget, remainder)) : linkTarget;
        if (candidate !== applicationName && !candidate.startsWith(`${applicationName}/`)) {
          fail(`${linkPath} escapes the application bundle through a symlink chain`);
        }
        followedLink = true;
        break;
      }
      if (type !== undefined && type !== DIRECTORY && index < segments.length - 1) {
        fail(`${linkPath} resolves through a non-directory archive entry`);
      }
    }
    if (followedLink) continue;
    if (!targetExists(candidate, exactPaths)) {
      fail(`${linkPath} points to a missing archive entry`);
    }
    return candidate;
  }
  fail(`${linkPath} exceeds the symlink resolution limit`);
}

/**
 * Validate the central directory and every symlink payload before `ditto`
 * receives an archive. A signed macOS app legitimately contains relative
 * framework symlinks, so rejecting every link would corrupt bundle semantics;
 * only links whose normalized targets stay inside the one expected `.app` are
 * accepted.
 */
export async function preflightMacApplicationZip(
  zipPath: string,
  expectedApplicationName: string,
): Promise<void> {
  const zipFile = await openZip(zipPath);
  const entries: ArchiveEntry[] = [];
  const exactPaths = new Set<string>();
  const caseFoldedPaths = new Set<string>();
  const typesByCaseFoldedPath = new Map<string, number>();
  let expandedBytes = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      zipFile.once("error", reject);
      zipFile.once("end", resolve);
      zipFile.on("entry", (entry: Entry) => {
        try {
          if (entries.length >= MAX_ENTRIES) fail("archive contains too many entries");
          const relativePath = canonicalEntryPath(entry.fileName);
          const root = relativePath.split("/", 1)[0];
          if (root !== expectedApplicationName && root !== "__MACOSX") {
            fail(`unexpected top-level entry ${JSON.stringify(root)}`);
          }
          const folded = foldedArchivePath(relativePath);
          if (exactPaths.has(relativePath) || caseFoldedPaths.has(folded)) {
            fail(`duplicate or case-colliding entry ${JSON.stringify(relativePath)}`);
          }
          exactPaths.add(relativePath);
          caseFoldedPaths.add(folded);

          const host = entry.versionMadeBy >>> 8;
          if (host !== UNIX_HOST) fail(`${relativePath} has no trustworthy Unix mode`);
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const type = mode & FILE_TYPE_MASK;
          if (![REGULAR_FILE, DIRECTORY, SYMBOLIC_LINK].includes(type)) {
            fail(`${relativePath} has unsupported Unix file type ${type.toString(8)}`);
          }
          if ((mode & FORBIDDEN_PERMISSION_BITS) !== 0) {
            fail(`${relativePath} carries unsafe Unix permissions ${(mode & 0o7777).toString(8)}`);
          }
          if ((type === DIRECTORY) !== entry.fileName.endsWith("/")) {
            fail(`${relativePath} has inconsistent directory metadata`);
          }
          if (type === SYMBOLIC_LINK && entry.uncompressedSize > MAX_LINK_BYTES) {
            fail(`${relativePath} has an oversized symlink payload`);
          }
          expandedBytes += entry.uncompressedSize;
          if (expandedBytes > MAX_EXPANDED_BYTES) fail("archive expands beyond its safety limit");
          typesByCaseFoldedPath.set(folded, type);
          entries.push({ entry, relativePath, type });
          zipFile.readEntry();
        } catch (error) {
          reject(error);
        }
      });
      zipFile.readEntry();
    });

    if (
      typesByCaseFoldedPath.get(
        expectedApplicationName.normalize("NFC").toLocaleLowerCase("en-US"),
      ) !== DIRECTORY
    ) {
      fail(`archive does not contain ${expectedApplicationName} as its root directory`);
    }
    for (const candidate of entries) {
      const segments = candidate.relativePath.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        const parent = foldedArchivePath(segments.slice(0, index).join("/"));
        const parentType = typesByCaseFoldedPath.get(parent);
        if (parentType !== undefined && parentType !== DIRECTORY) {
          fail(`${candidate.relativePath} is nested beneath a non-directory archive entry`);
        }
      }
    }
    const linksByCaseFoldedPath = new Map<
      string,
      { readonly path: string; readonly target: string }
    >();
    for (const candidate of entries) {
      if (candidate.type !== SYMBOLIC_LINK) continue;
      const target = (await readEntry(zipFile, candidate.entry, MAX_LINK_BYTES)).toString("utf8");
      normalizedLinkTarget(candidate.relativePath, target, expectedApplicationName);
      linksByCaseFoldedPath.set(foldedArchivePath(candidate.relativePath), {
        path: candidate.relativePath,
        target,
      });
    }
    for (const candidate of entries) {
      if (candidate.type === SYMBOLIC_LINK) {
        resolveArchiveSymlink(
          candidate.relativePath,
          expectedApplicationName,
          exactPaths,
          typesByCaseFoldedPath,
          linksByCaseFoldedPath,
        );
      }
    }
  } finally {
    zipFile.close();
  }
}
