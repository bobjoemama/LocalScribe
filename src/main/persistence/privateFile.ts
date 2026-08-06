import { open } from "node:fs/promises";

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
 * The descriptor is tightened before any plaintext is written, so there is no
 * instant at which the content exists under the old permissions.
 *
 * Ownership is not changed and no attempt is made to fix a directory the user
 * chose; on a filesystem without POSIX permissions (an exFAT stick, an SMB
 * share) `chmod` is a no-op, and this cannot make that safe. It makes the
 * ordinary case correct rather than pretending about the rest.
 */
export async function writePrivateFile(filePath: string, contents: string): Promise<void> {
  const handle = await open(filePath, "w", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
}
