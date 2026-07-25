import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanStaleAudioCaches,
  createAudioCache,
  removeAudioCache,
} from "../src/main/audioCache";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await import("node:fs/promises").then(({ rm }) =>
      rm(directory, { recursive: true, force: true }),
    );
  }
});
describe("private audio cache lifecycle", () => {
  it("creates a random direct child and removes only that cache", async () => {
    const parent = await temporaryDirectory("localscribe-audio-parent-");
    const cache = await createAudioCache(parent);
    await writeFile(path.join(cache, "recording.wav"), "audio");

    expect(path.dirname(cache)).toBe(parent);
    expect(path.basename(cache)).toMatch(/^localscribe-audio-[A-Za-z0-9]{6}$/);

    await removeAudioCache(parent, cache);
    await expect(access(cache, constants.F_OK)).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "never follows a stale cache symlink into unrelated files",
    async () => {
      const parent = await temporaryDirectory("localscribe-audio-parent-");
      const outside = await temporaryDirectory("localscribe-audio-victim-");
      const victim = path.join(outside, "victim.wav");
      await writeFile(victim, "keep me");
      const trap = path.join(parent, "localscribe-audio-Ab12Cd");
      await symlink(outside, trap, "dir");

      await cleanStaleAudioCaches(parent);

      await expect(readFile(victim, "utf8")).resolves.toBe("keep me");
      await expect(access(trap, constants.F_OK)).rejects.toThrow();
    },
  );

  it("ignores non-cache directories and refuses an out-of-root removal", async () => {
    const parent = await temporaryDirectory("localscribe-audio-parent-");
    const unrelated = path.join(parent, "unrelated");
    await mkdir(unrelated);
    await writeFile(path.join(unrelated, "victim.wav"), "keep me");

    await cleanStaleAudioCaches(parent);

    await expect(readFile(path.join(unrelated, "victim.wav"), "utf8"))
      .resolves.toBe("keep me");
    await expect(removeAudioCache(parent, unrelated))
      .rejects.toThrow("outside the temporary directory");
  });
});
