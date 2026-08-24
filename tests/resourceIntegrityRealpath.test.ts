import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Startup used to resolve a real path for every entry in the packaged tree.
 *
 * The set exists only to prove that each symlink resolves to something inside
 * the same scanned tree, and the packaged macOS app has 13 symlinks — but the
 * set was built by calling `realpathSync` once per *non-symlink* entry, 14,475
 * of them, each resolving every component of a deep path. Measured on the real
 * packaged Resources tree: 325.9 ms, synchronously, inside `app.whenReady()`
 * before the pill window, the database, the worker, or any IPC handler exists.
 * The app simply looked slow to launch.
 *
 * The real paths are derivable with no syscalls: the scan only recurses into
 * entries `lstat` reports as real directories, so no scanned entry ever sits
 * beneath an unresolved symlink, and a non-symlink child's real path is its
 * parent's real path joined with its name.
 *
 * These tests pin the two things that could regress: the cost must not scale
 * with the tree, and the containment check must stay exact.
 */

const counters = vi.hoisted(() => ({ realpath: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const counted = (...args: Parameters<typeof actual.realpathSync>) => {
    counters.realpath += 1;
    return actual.realpathSync(...args);
  };
  return {
    ...actual,
    // `realpathSync.native` is a property of the function itself.
    realpathSync: Object.assign(counted, actual.realpathSync),
  };
});

const { buildResourceIntegrityExpectation } = await import("../src/main/resourceIntegrity");
const { resourcePolicyFor } = await import("../src/shared/platformResourcePolicy");

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "localscribe-realpath-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeFixtureFile(resourcesPath: string, relativePath: string, content = relativePath): void {
  const target = path.join(resourcesPath, ...relativePath.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/** Extra files land under the recursive runtime root, so they are all scanned. */
function makeFixture(extraFiles: number, extraDepth = 0): string {
  const resourcesPath = makeTemporaryDirectory();
  const policy = resourcePolicyFor("darwin", "arm64");
  writeFixtureFile(resourcesPath, `${policy.workerDirectory}/__init__.py`);
  writeFixtureFile(resourcesPath, `${policy.workerDirectory}/__main__.py`);
  writeFixtureFile(resourcesPath, policy.runtimeExecutable, "python");
  for (const file of policy.helperFiles) writeFixtureFile(resourcesPath, file);
  for (const file of policy.manifestFiles) writeFixtureFile(resourcesPath, file);
  for (const file of policy.licenseFiles) writeFixtureFile(resourcesPath, file);
  for (const file of policy.brandingFiles) writeFixtureFile(resourcesPath, file);

  const nesting = Array.from({ length: extraDepth }, (_, index) => `deep${index}`).join("/");
  for (let index = 0; index < extraFiles; index += 1) {
    const directory = nesting.length > 0 ? `python-runtime/${nesting}` : "python-runtime";
    writeFixtureFile(resourcesPath, `${directory}/generated-${index}.txt`, String(index));
  }
  return resourcesPath;
}

function countRealpath(run: () => void): number {
  counters.realpath = 0;
  run();
  return counters.realpath;
}

beforeEach(() => {
  counters.realpath = 0;
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolving real paths during the integrity scan", () => {
  it("does not resolve one real path per entry", () => {
    const small = countRealpath(() => buildResourceIntegrityExpectation(makeFixture(0), "darwin", "arm64"));
    const large = countRealpath(() => buildResourceIntegrityExpectation(makeFixture(400), "darwin", "arm64"));

    // 400 additional scanned files must cost nothing extra. Before the change
    // this grew one-for-one, which is what made the packaged tree cost 325.9ms.
    expect(large).toBe(small);
  });

  it("does not resolve more real paths as the tree gets deeper", () => {
    const shallow = countRealpath(() => buildResourceIntegrityExpectation(makeFixture(20, 0), "darwin", "arm64"));
    const deep = countRealpath(() => buildResourceIntegrityExpectation(makeFixture(20, 12), "darwin", "arm64"));

    expect(deep).toBe(shallow);
  });

  it("resolves little more than one real path per scan root", () => {
    const calls = countRealpath(() => buildResourceIntegrityExpectation(makeFixture(50), "darwin", "arm64"));

    // Six candidate roots, plus the resources container itself. Nothing here
    // has symlinks, so this is the whole budget.
    expect(calls).toBeLessThanOrEqual(8);
  });

  /*
   * The containment check is the reason the set exists, so the cheaper set has
   * to stay exactly as strict. `.DS_Store` is a forbidden packaged resource, so
   * the scan skips it — meaning its real path is legitimately absent from the
   * set, and a symlink aimed at it must still be refused even though the file
   * really does sit inside the resource tree.
   */
  it("still refuses a symlink to a real path inside the tree that was not scanned", () => {
    const resourcesPath = makeFixture(0);
    writeFixtureFile(resourcesPath, "python-runtime/.DS_Store", "skipped");
    const executable = path.join(resourcesPath, "python-runtime", "venv", "bin", "python3");
    unlinkSync(executable);
    symlinkSync("../../.DS_Store", executable);

    expect(() => buildResourceIntegrityExpectation(resourcesPath, "darwin", "arm64")).toThrow(
      /escaping symlink/,
    );
  });

  it("still accepts a symlink to a scanned file in the same tree", () => {
    const resourcesPath = makeFixture(0);
    writeFixtureFile(resourcesPath, "python-runtime/real-python", "python");
    const executable = path.join(resourcesPath, "python-runtime", "venv", "bin", "python3");
    unlinkSync(executable);
    symlinkSync("../../real-python", executable);

    expect(() => buildResourceIntegrityExpectation(resourcesPath, "darwin", "arm64")).not.toThrow();
  });

  it("still refuses a symlink that leaves the tree entirely", () => {
    const resourcesPath = makeFixture(0);
    const outside = makeTemporaryDirectory();
    writeFileSync(path.join(outside, "python"), "elsewhere");
    const executable = path.join(resourcesPath, "python-runtime", "venv", "bin", "python3");
    unlinkSync(executable);
    symlinkSync(path.join(outside, "python"), executable);

    expect(() => buildResourceIntegrityExpectation(resourcesPath, "darwin", "arm64")).toThrow(
      /unsafe symlink|escaping symlink/,
    );
  });
});
