import path from "node:path";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  rm,
  unlink,
} from "node:fs/promises";

export const AUDIO_CACHE_DIRECTORY_PREFIX = "localscribe-audio-";
const AUDIO_CACHE_DIRECTORY_PATTERN = /^localscribe-audio-[A-Za-z0-9]{6}$/;

function directAudioCachePath(temporaryDirectory: string, entryName: string): string | null {
  if (!AUDIO_CACHE_DIRECTORY_PATTERN.test(entryName)) return null;
  const parent = path.resolve(temporaryDirectory);
  const candidate = path.resolve(parent, entryName);
  return path.dirname(candidate) === parent ? candidate : null;
}
/**
 * Removes only LocalScribe's direct, mkdtemp-shaped cache children. Symlinks
 * are unlinked as links and are never passed to recursive removal.
 */
export async function cleanStaleAudioCaches(temporaryDirectory: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(temporaryDirectory, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(entries.map(async (entry) => {
    const candidate = directAudioCachePath(temporaryDirectory, entry.name);
    if (!candidate) return;
    try {
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) {
        await unlink(candidate);
        return;
      }
      if (!metadata.isDirectory()) return;
      await rm(candidate, { recursive: true, force: true });
    } catch {
      // A stale entry may disappear between discovery and cleanup.
    }
  }));
}

/** Creates one unpredictable, user-only audio cache for this app process. */
export async function createAudioCache(temporaryDirectory: string): Promise<string> {
  const cacheDirectory = await mkdtemp(
    path.join(temporaryDirectory, AUDIO_CACHE_DIRECTORY_PREFIX),
  );
  await chmod(cacheDirectory, 0o700);
  return cacheDirectory;
}

/** Removes a cache only when it is a direct child created by createAudioCache. */
export async function removeAudioCache(
  temporaryDirectory: string,
  cacheDirectory: string | null,
): Promise<void> {
  if (!cacheDirectory) return;
  const parent = path.resolve(temporaryDirectory);
  const resolved = path.resolve(cacheDirectory);
  if (
    path.dirname(resolved) !== parent
    || !AUDIO_CACHE_DIRECTORY_PATTERN.test(path.basename(resolved))
  ) {
    throw new Error("Refusing to remove an audio cache outside the temporary directory.");
  }

  let metadata;
  try {
    metadata = await lstat(resolved);
  } catch {
    return;
  }
  if (metadata.isSymbolicLink()) {
    await unlink(resolved);
    return;
  }
  if (!metadata.isDirectory()) {
    throw new Error("Refusing to remove an audio cache path that is not a directory.");
  }
  await rm(resolved, { recursive: true, force: true });
}
