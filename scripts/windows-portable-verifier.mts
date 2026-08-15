import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadReleaseMetadata,
  releaseLayout,
} from "./release-metadata.mts";
import { extractVerifiedZip } from "./safe-zip-extraction.mts";

const HASH_BUFFER_BYTES = 1024 * 1024;

interface FileIdentity {
  relativePath: string;
  bytes: number;
  sha256: string;
}

function fail(message: string): never {
  throw new Error(`Windows portable verification failed: ${message}`);
}

function hashFile(filePath: string, expectedBytes: number): string {
  const descriptor = openSync(filePath, "r");
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size !== expectedBytes) {
      fail(`file changed before hashing: ${filePath}`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let bytes = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      bytes += count;
      if (bytes > expectedBytes) fail(`file grew while hashing: ${filePath}`);
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor);
    if (!after.isFile() || after.size !== expectedBytes || bytes !== expectedBytes) {
      fail(`file changed while hashing: ${filePath}`);
    }
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function inventory(rootPath: string): FileIdentity[] {
  const root = realpathSync(rootPath);
  const files: FileIdentity[] = [];
  const visit = (candidate: string): void => {
    const metadata = lstatSync(candidate);
    if (metadata.isSymbolicLink()) {
      fail(`portable tree contains a link/reparse entry: ${path.relative(root, candidate)}`);
    }
    if (metadata.isDirectory()) {
      for (const child of readdirSync(candidate).sort()) visit(path.join(candidate, child));
      return;
    }
    if (!metadata.isFile()) {
      fail(`portable tree contains an unsupported entry: ${path.relative(root, candidate)}`);
    }
    const relativePath = path.relative(root, candidate).split(path.sep).join("/");
    if (
      relativePath.length === 0 ||
      relativePath.startsWith("../") ||
      path.posix.isAbsolute(relativePath)
    ) {
      fail(`portable tree contains an unsafe path: ${relativePath}`);
    }
    files.push({
      relativePath,
      bytes: metadata.size,
      sha256: hashFile(candidate, metadata.size),
    });
  };
  visit(root);
  return files.sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  );
}

function safeCleanup(directory: string): void {
  const resolved = path.resolve(directory);
  const root = path.resolve(tmpdir());
  if (
    !resolved.startsWith(`${root}${path.sep}`) ||
    !path.basename(resolved).startsWith("localscribe-windows-portable-")
  ) {
    fail(`refusing to remove unexpected temporary path: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true });
}

export async function assertWindowsPortableArtifact(options: {
  stagedDirectory: string;
  zipPath: string;
  verifyPackagedArchive?: boolean;
}): Promise<{ fileCount: number; zipBytes: number }> {
  const releaseLayout_ = releaseLayout(loadReleaseMetadata(), "win32");
  const stagedDirectory = path.resolve(options.stagedDirectory);
  const zipPath = path.resolve(options.zipPath);
  for (const [candidate, label, directory] of [
    [stagedDirectory, "staged directory", true],
    [zipPath, "portable ZIP", false],
  ] as const) {
    if (!existsSync(candidate)) fail(`${label} is missing: ${candidate}`);
    const metadata = lstatSync(candidate);
    if (
      metadata.isSymbolicLink() ||
      (directory ? !metadata.isDirectory() : !metadata.isFile())
    ) {
      fail(`${label} is not an ordinary ${directory ? "directory" : "file"}: ${candidate}`);
    }
    if (!directory && metadata.size === 0) fail(`${label} is empty`);
  }
  for (const required of [
    path.join(stagedDirectory, releaseLayout_.applicationName),
    path.join(stagedDirectory, "resources", "app.asar"),
  ]) {
    if (!existsSync(required) || !lstatSync(required).isFile()) {
      fail(`staged package is missing ${required}`);
    }
  }

  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "localscribe-windows-portable-"));
  try {
    await extractVerifiedZip(zipPath, temporaryRoot);
    const extractedExecutable = path.join(
      temporaryRoot,
      releaseLayout_.applicationName,
    );
    const extractedAsar = path.join(temporaryRoot, "resources", "app.asar");
    if (!existsSync(extractedExecutable) || !existsSync(extractedAsar)) {
      fail(
        `ZIP does not contain ${releaseLayout_.applicationName} and ` +
        "resources/app.asar at its root",
      );
    }
    const stagedInventory = inventory(stagedDirectory);
    const extractedInventory = inventory(temporaryRoot);
    if (JSON.stringify(extractedInventory) !== JSON.stringify(stagedInventory)) {
      const stagedNames = new Set(stagedInventory.map((entry) => entry.relativePath));
      const extractedNames = new Set(extractedInventory.map((entry) => entry.relativePath));
      const missing = stagedInventory
        .filter((entry) => !extractedNames.has(entry.relativePath))
        .map((entry) => entry.relativePath);
      const extra = extractedInventory
        .filter((entry) => !stagedNames.has(entry.relativePath))
        .map((entry) => entry.relativePath);
      fail(
        "ZIP is not an exact byte-for-byte copy of the staged package" +
        `${missing.length > 0 ? `; missing [${missing.join(", ")}]` : ""}` +
        `${extra.length > 0 ? `; extra [${extra.join(", ")}]` : ""}`,
      );
    }
    if (options.verifyPackagedArchive !== false) {
      execFileSync(
        process.execPath,
        [path.resolve("scripts/verify-packaged-main.mjs"), extractedAsar],
        { stdio: "inherit" },
      );
      execFileSync(
        process.execPath,
        [
          path.resolve("scripts/verify-packaged-archive.mjs"),
          extractedAsar,
          "win32",
          releaseLayout_.target.arch,
        ],
        { stdio: "inherit" },
      );
    }
    return {
      fileCount: stagedInventory.length,
      zipBytes: lstatSync(zipPath).size,
    };
  } finally {
    safeCleanup(temporaryRoot);
  }
}
