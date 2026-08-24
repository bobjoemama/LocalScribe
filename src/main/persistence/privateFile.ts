import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

const PRIVATE_FILE_MODE = 0o600;

function unsafeTarget(filePath: string): Error {
  return new Error(`Refusing to replace an unsafe private-file target: ${path.basename(filePath)}`);
}

async function descriptorForExistingRegularFile(filePath: string): Promise<FileHandle | null> {
  let pathInfo: Stats;
  try {
    pathInfo = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) throw unsafeTarget(filePath);

  let handle: FileHandle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw unsafeTarget(filePath);
    throw error;
  }
  try {
    const descriptorInfo = await handle.stat();
    if (
      !descriptorInfo.isFile()
      || descriptorInfo.dev !== pathInfo.dev
      || descriptorInfo.ino !== pathInfo.ino
    ) {
      throw unsafeTarget(filePath);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function validateExistingTarget(filePath: string): Promise<void> {
  const handle = await descriptorForExistingRegularFile(filePath);
  await handle?.close();
}

/**
 * Write a file that only this account can read, whether or not it already exists.
 *
 * `writeFile(path, data, { mode: 0o600 })` applies `mode` only on the open that
 * *creates* the file, so writing over an existing target silently keeps that
 * target's permissions. A history export is the case that matters: exporting
 * twice to the same name, or over a file the user unzipped or their sync client
 * created, left a 0644 file holding every decrypted transcript — readable by
 * every account on the machine, and by anything else running as the user.
 *
 * Plaintext is written and flushed through a fresh same-directory 0600
 * descriptor before an atomic rename, so the previous target remains intact
 * on a failed write and there is no partial export at the destination path.
 *
 * Ownership is not changed and no attempt is made to fix a directory the user
 * chose; on a filesystem without POSIX permissions (an exFAT stick, an SMB
 * share) `chmod` is a no-op, and this cannot make that safe. It makes the
 * ordinary case correct rather than pretending about the rest. Symlink and
 * non-regular targets are rejected without being followed.
 */
export async function writePrivateFile(filePath: string, contents: string): Promise<void> {
  const directory = path.dirname(filePath);
  await validateExistingTarget(filePath);

  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.localscribe-${process.pid}-${randomUUID()}.tmp`,
  );
  let temporary: FileHandle | null = null;
  let renamed = false;
  try {
    temporary = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    if (!(await temporary.stat()).isFile()) throw unsafeTarget(temporaryPath);
    await temporary.chmod(PRIVATE_FILE_MODE);
    await temporary.writeFile(contents);
    await temporary.sync();
    await temporary.close();
    temporary = null;

    // Recheck immediately before replacement. rename() replaces the directory
    // entry itself rather than following a symlink, but rejecting a changed or
    // unsafe entry keeps the public contract strict and predictable.
    await validateExistingTarget(filePath);
    await rename(temporaryPath, filePath);
    renamed = true;

    // Flush the directory-entry replacement as well as the file bytes.
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await directoryHandle.stat()).isDirectory()) throw unsafeTarget(directory);
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await temporary?.close().catch(() => undefined);
    if (!renamed) await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
