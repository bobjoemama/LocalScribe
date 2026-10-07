import path from "node:path";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";

export const AUDIO_CACHE_DIRECTORY_PREFIX = "localscribe-audio-";
export const AUDIO_CACHE_OWNER_FILE = ".localscribe-owner";
const AUDIO_CACHE_DIRECTORY_PATTERN = /^localscribe-audio-[A-Za-z0-9]{6}$/;
// A positive safe-integer PID and the terminating newline, not an age limit.
const MAX_OWNER_BYTES = String(Number.MAX_SAFE_INTEGER).length + 1;
const cacheRepairs = new Map<string, Promise<void>>();

export class AudioCacheError extends Error {
  readonly code = "audio_storage_unavailable" as const;

  constructor(message = "Private audio storage is unavailable.", options?: ErrorOptions) {
    super(message, options);
    this.name = "AudioCacheError";
  }
}

function directAudioCachePath(temporaryDirectory: string, entryName: string): string | null {
  if (!AUDIO_CACHE_DIRECTORY_PATTERN.test(entryName)) return null;
  const parent = path.resolve(temporaryDirectory);
  const candidate = path.resolve(parent, entryName);
  return path.dirname(candidate) === parent ? candidate : null;
}

function knownAudioCachePath(temporaryDirectory: string, cacheDirectory: string): string {
  const resolved = path.resolve(cacheDirectory);
  if (
    !path.isAbsolute(cacheDirectory)
    || directAudioCachePath(temporaryDirectory, path.basename(resolved)) !== resolved
  ) {
    throw new AudioCacheError("Refusing audio storage outside the temporary directory.");
  }
  return resolved;
}

async function privateDirectory(directory: string) {
  const metadata = await lstat(directory);
  if (
    metadata.isSymbolicLink() || !metadata.isDirectory()
    || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0
  ) {
    throw new AudioCacheError("Private audio storage has unsafe ownership or permissions.");
  }
  return metadata;
}

/** Read a bounded PID lease through a descriptor, without following a link. */
async function readOwner(directory: string): Promise<number> {
  const owner = await open(path.join(directory, AUDIO_CACHE_OWNER_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await owner.stat();
    if (
      !metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.()
      || (metadata.mode & 0o077) !== 0 || metadata.size < 2 || metadata.size > MAX_OWNER_BYTES
    ) {
      throw new AudioCacheError("Private audio storage has an invalid owner lease.");
    }
    const bytes = Buffer.alloc(MAX_OWNER_BYTES);
    const { bytesRead } = await owner.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== metadata.size || (await owner.stat()).size !== metadata.size) {
      throw new AudioCacheError("Private audio storage owner lease changed.");
    }
    const value = bytes.subarray(0, bytesRead).toString("utf8");
    const pid = Number(value.trim());
    if (!/^[1-9][0-9]*\n$/.test(value) || !Number.isSafeInteger(pid) || pid <= 1) {
      throw new AudioCacheError("Private audio storage has an invalid owner lease.");
    }
    return pid;
  } finally { await owner.close(); }
}

function ownerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission failures and unknown outcomes are not evidence of a dead owner.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function writeThisProcessOwner(directory: string): Promise<void> {
  const ownerPath = path.join(directory, AUDIO_CACHE_OWNER_FILE);
  try {
    await writeFile(ownerPath, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (await readOwner(directory) !== process.pid) {
    throw new AudioCacheError("Private audio storage belongs to another process.");
  }
}

/** Remove only privately-owned cache directories whose valid PID lease is dead. */
export async function cleanStaleAudioCaches(temporaryDirectory: string): Promise<void> {
  let entries;
  try { entries = await readdir(temporaryDirectory, { withFileTypes: true }); }
  catch { return; }

  await Promise.all(entries.map(async (entry) => {
    const candidate = directAudioCachePath(temporaryDirectory, entry.name);
    if (!candidate) return;
    try {
      const metadata = await privateDirectory(candidate);
      const pid = await readOwner(candidate);
      if (ownerIsAlive(pid)) return;
      // A new lease or replacement directory must not inherit the old verdict.
      const current = await privateDirectory(candidate);
      if (current.dev !== metadata.dev || current.ino !== metadata.ino || await readOwner(candidate) !== pid) return;
      if (ownerIsAlive(pid)) return;
      await rm(candidate, { recursive: true, force: true });
    } catch {
      // Creation races, legacy/unmarked roots and uncertain ownership stay intact.
    }
  }));
}

/** Create one unpredictable, user-only cache and lease it to this process. */
export async function createAudioCache(temporaryDirectory: string): Promise<string> {
  try {
    const cacheDirectory = await mkdtemp(path.join(temporaryDirectory, AUDIO_CACHE_DIRECTORY_PREFIX));
    await chmod(cacheDirectory, 0o700);
    await privateDirectory(cacheDirectory);
    await writeThisProcessOwner(cacheDirectory);
    return cacheDirectory;
  } catch (error) {
    if (error instanceof AudioCacheError) throw error;
    throw new AudioCacheError(undefined, { cause: error });
  }
}

/** Restore only this app's known path, so the warm worker keeps its original TMPDIR. */
async function repairAudioCache(directory: string): Promise<void> {
  try {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await privateDirectory(directory);
    await writeThisProcessOwner(directory);
    await privateDirectory(directory);
  } catch (error) {
    if (error instanceof AudioCacheError) throw error;
    throw new AudioCacheError(undefined, { cause: error });
  }
}

export function ensureAudioCache(temporaryDirectory: string, cacheDirectory: string): Promise<void> {
  let directory: string;
  try { directory = knownAudioCachePath(temporaryDirectory, cacheDirectory); }
  catch (error) { return Promise.reject(error); }
  const pending = cacheRepairs.get(directory);
  if (pending) return pending;
  // Concurrent requests in this process share one lease write, so none reads
  // another request's freshly-created marker before its contents are written.
  const repair = repairAudioCache(directory).finally(() => { cacheRepairs.delete(directory); });
  cacheRepairs.set(directory, repair);
  return repair;
}

/** Remove the current process's direct cache; links are unlinked, never followed. */
export async function removeAudioCache(temporaryDirectory: string, cacheDirectory: string | null): Promise<void> {
  if (!cacheDirectory) return;
  const resolved = knownAudioCachePath(temporaryDirectory, cacheDirectory);
  let metadata;
  try { metadata = await lstat(resolved); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new AudioCacheError(undefined, { cause: error });
  }
  if (metadata.isSymbolicLink()) {
    await unlink(resolved);
    return;
  }
  await privateDirectory(resolved);
  if (await readOwner(resolved) !== process.pid) {
    throw new AudioCacheError("Refusing to remove another process's audio storage.");
  }
  await rm(resolved, { recursive: true, force: true });
}
