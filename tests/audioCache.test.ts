import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_CACHE_OWNER_FILE,
  cleanStaleAudioCaches,
  createAudioCache,
  ensureAudioCache,
  removeAudioCache,
} from "../src/main/audioCache";

const temporaryDirectories: string[] = [];
const children: ChildProcess[] = [];

async function childOwnedCache(parent: string): Promise<{ child: ChildProcess; cache: string }> {
  const moduleUrl = pathToFileURL(path.resolve("src/main/audioCache.ts")).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createAudioCache } from ${JSON.stringify(moduleUrl)};
    const cache = await createAudioCache(${JSON.stringify(parent)});
    process.send(cache);
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(child);
  const cache = await new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.once("message", (value) => typeof value === "string" ? resolve(value) : reject(new Error("Invalid child cache")));
    child.once("exit", () => reject(new Error("Child exited before leasing its cache")));
  });
  return { child, cache };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  }
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
    expect((await lstat(cache)).mode & 0o777).toBe(0o700);
    expect((await lstat(path.join(cache, AUDIO_CACHE_OWNER_FILE))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(cache, AUDIO_CACHE_OWNER_FILE), "utf8")).toBe(`${process.pid}\n`);

    await removeAudioCache(parent, cache);
    await expect(access(cache, constants.F_OK)).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "preserves an unowned cache symlink without following it into unrelated files",
    async () => {
      const parent = await temporaryDirectory("localscribe-audio-parent-");
      const outside = await temporaryDirectory("localscribe-audio-victim-");
      const victim = path.join(outside, "victim.wav");
      await writeFile(victim, "keep me");
      const trap = path.join(parent, "localscribe-audio-Ab12Cd");
      await symlink(outside, trap, "dir");

      await cleanStaleAudioCaches(parent);

      await expect(readFile(victim, "utf8")).resolves.toBe("keep me");
      expect((await lstat(trap)).isSymbolicLink()).toBe(true);
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

  it("keeps both live instances and removes only the child cache after its owner exits", async () => {
    const parent = await temporaryDirectory("localscribe-audio-parent-");
    const ownCache = await createAudioCache(parent);
    const { child, cache: childCache } = await childOwnedCache(parent);
    await writeFile(path.join(ownCache, "recording.wav"), "parent audio");
    await writeFile(path.join(childCache, "recording.wav"), "child audio");

    await cleanStaleAudioCaches(parent);
    expect(await readFile(path.join(ownCache, "recording.wav"), "utf8")).toBe("parent audio");
    expect(await readFile(path.join(childCache, "recording.wav"), "utf8")).toBe("child audio");
    await expect(removeAudioCache(parent, childCache)).rejects.toMatchObject({ code: "audio_storage_unavailable" });

    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    await cleanStaleAudioCaches(parent);
    await expect(access(childCache)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(ownCache, "recording.wav"), "utf8")).toBe("parent audio");
  });

  it("restores a missing known root and lease at the same path for the warm worker", async () => {
    const parent = await temporaryDirectory("localscribe-audio-parent-");
    const cache = await createAudioCache(parent);
    await rm(cache, { recursive: true });
    await Promise.all([ensureAudioCache(parent, cache), ensureAudioCache(parent, cache)]);
    expect((await lstat(cache)).mode & 0o777).toBe(0o700);
    expect(await readFile(path.join(cache, AUDIO_CACHE_OWNER_FILE), "utf8")).toBe(`${process.pid}\n`);
    await writeFile(path.join(cache, "recording.wav"), "recovered audio", { mode: 0o600, flag: "wx" });
    expect(await readFile(path.join(cache, "recording.wav"), "utf8")).toBe("recovered audio");
    await rm(path.join(cache, AUDIO_CACHE_OWNER_FILE));
    await ensureAudioCache(parent, cache);
    expect(await readFile(path.join(cache, AUDIO_CACHE_OWNER_FILE), "utf8")).toBe(`${process.pid}\n`);
  });

  it("retains unmarked, malformed and inaccessible-owner caches during cleanup", async () => {
    const parent = await temporaryDirectory("localscribe-audio-parent-");
    const unmarked = await createAudioCache(parent);
    const malformed = await createAudioCache(parent);
    const inaccessible = await createAudioCache(parent);
    await rm(path.join(unmarked, AUDIO_CACHE_OWNER_FILE));
    await writeFile(path.join(malformed, AUDIO_CACHE_OWNER_FILE), "not a PID\n");
    const probe = vi.spyOn(process, "kill");
    for (const code of ["EPERM", undefined]) {
      probe.mockImplementation(() => { throw Object.assign(new Error("Unknown liveness"), { code }); });
      await cleanStaleAudioCaches(parent);
      for (const cache of [unmarked, malformed, inaccessible]) expect((await lstat(cache)).isDirectory()).toBe(true);
    }
  });

  it("refuses wrong-owner, permissive, linked and non-directory recovery roots", async () => {
    const parent = await temporaryDirectory("localscribe-audio-parent-");
    const { cache: foreign } = await childOwnedCache(parent);
    await expect(ensureAudioCache(parent, foreign)).rejects.toMatchObject({ code: "audio_storage_unavailable" });
    const cache = await createAudioCache(parent);
    await chmod(cache, 0o755);
    await expect(ensureAudioCache(parent, cache)).rejects.toMatchObject({ code: "audio_storage_unavailable" });
    await chmod(cache, 0o700);
    await rm(cache, { recursive: true });
    await symlink(foreign, cache, "dir");
    await expect(ensureAudioCache(parent, cache)).rejects.toMatchObject({ code: "audio_storage_unavailable" });
    expect((await lstat(foreign)).isDirectory()).toBe(true);
    await rm(cache);
    await writeFile(cache, "keep me");
    await expect(ensureAudioCache(parent, cache)).rejects.toMatchObject({ code: "audio_storage_unavailable" });
    expect(await readFile(cache, "utf8")).toBe("keep me");
    await expect(ensureAudioCache(parent, path.join(parent, "arbitrary"))).rejects.toMatchObject({ code: "audio_storage_unavailable" });
  });

  it("refuses linked, oversized and broadly-readable leases without following their contents", async () => {
    const parent = await temporaryDirectory("localscribe-audio-parent-");
    const cache = await createAudioCache(parent);
    const marker = path.join(cache, AUDIO_CACHE_OWNER_FILE);
    const outside = path.join(parent, "unrelated-owner");
    await writeFile(outside, `${process.pid}\n`, { mode: 0o600 });
    await rm(marker);
    await symlink(outside, marker);
    await expect(ensureAudioCache(parent, cache)).rejects.toMatchObject({ code: "audio_storage_unavailable" });
    await cleanStaleAudioCaches(parent);
    expect(await readFile(outside, "utf8")).toBe(`${process.pid}\n`);
    expect((await lstat(marker)).isSymbolicLink()).toBe(true);
    await rm(marker);
    await writeFile(marker, `${Number.MAX_SAFE_INTEGER}0\n`, { mode: 0o600 });
    await expect(ensureAudioCache(parent, cache)).rejects.toMatchObject({ code: "audio_storage_unavailable" });
    await writeFile(marker, `${process.pid}\n`);
    await chmod(marker, 0o644);
    await expect(ensureAudioCache(parent, cache)).rejects.toMatchObject({ code: "audio_storage_unavailable" });
  });
});
