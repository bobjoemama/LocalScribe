import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";

export interface RegularExecutableProof {
  readonly sha256: string;
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly changedAtMs: number;
}

export type ExecutableProofReader = (
  executablePath: string,
) => RegularExecutableProof | null;

function sameFileIdentity(
  left: ReturnType<typeof fstatSync>,
  right: ReturnType<typeof fstatSync>,
): boolean {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

/**
 * Hashes and identifies one O_NOFOLLOW descriptor. Path-based lstat/read/lstat
 * can hash a different inode than either stat under a rename race; a single
 * descriptor cannot. Metadata is compared before and after the bounded read,
 * and symlinks are never accepted as executable authority.
 */
export function proveRegularExecutable(
  executablePath: string,
): RegularExecutableProof | null {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      executablePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 0) return null;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const bytesRead = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - position),
        position,
      );
      if (bytesRead <= 0) return null;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = fstatSync(descriptor);
    if (position !== before.size || !sameFileIdentity(before, after)) return null;
    return {
      sha256: hash.digest("hex"),
      device: after.dev,
      inode: after.ino,
      mode: after.mode,
      size: after.size,
      modifiedAtMs: after.mtimeMs,
      changedAtMs: after.ctimeMs,
    };
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export function digestRegularExecutable(executablePath: string): string | null {
  return proveRegularExecutable(executablePath)?.sha256 ?? null;
}

export function sameRegularExecutableProof(
  left: RegularExecutableProof,
  right: RegularExecutableProof,
): boolean {
  return left.sha256 === right.sha256
    && left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.size === right.size
    && left.modifiedAtMs === right.modifiedAtMs
    && left.changedAtMs === right.changedAtMs;
}
