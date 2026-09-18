import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildResourceIntegrityExpectation } from "../src/main/resourceIntegrity";
import { resourcePolicyFor } from "../src/shared/platformResourcePolicy";

/*
 * The Merkle root over the packaged resource tree is recomputed on every
 * launch, synchronously, as the first statement inside `app.whenReady()` —
 * before the pill window, the database, the worker, or any IPC handler exists.
 * So its cost is startup latency the user experiences as the app not starting.
 *
 * Finding each directory's children used to mean materializing the entire
 * entry-hash map and calling `dirname` on every element, once per directory:
 * O(directories x entries). On the real packaged macOS tree — 14,467 entries,
 * 2,243 directories — that is ~32 million array copies and ~32 million
 * `dirname` calls, measured at 1.2-4.7 s. Worse, it grows with the square of
 * the packaged Python runtime, so adding a dependency made launch
 * disproportionately slower.
 *
 * Indexing children by parent in one pass is the same computation in a
 * different order. That "same" is the load-bearing claim, and it is not
 * cosmetic: the root is compared against a value embedded in the shipped
 * app.asar, so a root that changed would make every already-built app refuse to
 * start. The golden vector below is the guard.
 */

const temporaryDirectories: string[] = [];

/**
 * The root of a fixed, deep, wide tree.
 *
 * Captured by running the *previous* quadratic implementation over this exact
 * fixture, so it is a cross-implementation vector rather than a snapshot of
 * whatever the current code happens to do. Any future change to the hashing
 * scheme must update this deliberately — and must rebuild every artifact whose
 * embedded expectation was computed under the old scheme.
 */
// Deliberately regenerated when the five unreviewed Whisper manifests left
// the selected inventory. The hashing algorithm is unchanged.
const GOLDEN_ROOT = "38dd8cc66cc92b71939a0e99ff9e4e9d19166b0005cd1c4f1bbb47f875efe033";

function fixture(): string {
  const resourcesPath = mkdtempSync(path.join(tmpdir(), "localscribe-root-"));
  temporaryDirectories.push(resourcesPath);
  const policy = resourcePolicyFor("darwin", "arm64");

  const write = (relativePath: string, content: string): void => {
    const target = path.join(resourcesPath, ...relativePath.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };

  write(`${policy.workerDirectory}/__init__.py`, `${policy.workerDirectory}/__init__.py`);
  write(`${policy.workerDirectory}/__main__.py`, `${policy.workerDirectory}/__main__.py`);
  write(policy.runtimeExecutable, "python");
  for (const file of policy.helperFiles) write(file, file);
  for (const file of policy.manifestFiles) write(file, file);
  for (const file of policy.licenseFiles) write(file, file);
  for (const file of policy.brandingFiles) write(file, file);

  /*
   * Depth and breadth both matter. The old implementation's cost came from the
   * directory count, and its ordering came from processing deepest-first, so a
   * flat fixture would exercise neither. Nested siblings also pin that a
   * directory's hash is folded into its parent's child list.
   */
  const runtimeRoot = path.posix.dirname(policy.runtimeExecutable);
  for (let branch = 0; branch < 6; branch += 1) {
    let directory = `${runtimeRoot}/lib/branch-${branch}`;
    for (let depth = 0; depth < 5; depth += 1) {
      directory = `${directory}/level-${depth}`;
      for (let file = 0; file < 4; file += 1) {
        write(`${directory}/module-${file}.py`, `branch ${branch} depth ${depth} file ${file}`);
      }
    }
  }
  return resourcesPath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("packaged resource tree root", () => {
  it("still produces the root the previous implementation produced", () => {
    const expectation = buildResourceIntegrityExpectation(fixture(), "darwin", "arm64");
    expect(expectation.root).toBe(GOLDEN_ROOT);
  });

  it("is stable across repeated builds of the same tree", () => {
    const first = buildResourceIntegrityExpectation(fixture(), "darwin", "arm64");
    const second = buildResourceIntegrityExpectation(fixture(), "darwin", "arm64");
    expect(second.root).toBe(first.root);
    expect(second.entryCount).toBe(first.entryCount);
  });

  it("still changes when a single nested byte changes", () => {
    const resourcesPath = fixture();
    const before = buildResourceIntegrityExpectation(resourcesPath, "darwin", "arm64");

    // Deepest leaf, so the change has to propagate up five directory hashes to
    // reach the root. A one-pass index that dropped a level would pass the
    // golden vector and fail here.
    writeFileSync(
      path.join(
        resourcesPath,
        ...`${path.posix.dirname(resourcePolicyFor("darwin", "arm64").runtimeExecutable)}/lib/branch-3/level-0/level-1/level-2/level-3/level-4/module-2.py`
          .split("/"),
      ),
      "tampered",
    );

    const after = buildResourceIntegrityExpectation(resourcesPath, "darwin", "arm64");
    expect(after.root).not.toBe(before.root);
    expect(after.entryCount).toBe(before.entryCount);
  });

  it("does not spend quadratic time as the tree grows", () => {
    /*
     * Counted, not timed.
     *
     * This guard was originally a wall-clock ratio between two tree sizes. That
     * measured the right shape but through a noisy instrument: the measured
     * window included the filesystem scan, which dominates the arithmetic being
     * guarded and varies with page-cache state and machine load. It failed here
     * at a 3.80x ratio on a machine busy running a model smoke, minutes after
     * passing on the same commit. A guard that reports a defect because the
     * machine was busy is not a guard.
     *
     * `path.posix.dirname` is called in exactly two places in the whole module,
     * both inside `treeRoot`: once per non-directory entry when seeding the
     * child index, and once per directory when folding a directory hash into
     * its parent. Every entry is one or the other, so a linear implementation
     * calls it exactly `entryCount` times — an exact integer, on any machine,
     * under any load.
     *
     * The quadratic implementation called it once per entry *per directory*.
     * On the packaged macOS tree — 14,467 entries, 2,243 directories — that is
     * ~32 million calls against 14,467. This assertion is `toBe`, not a ratio
     * with a tolerance band, so any return to per-directory scanning fails it
     * by six orders of magnitude rather than by a hair.
     */
    const buildTree = (branches: number): string => {
      const resourcesPath = mkdtempSync(path.join(tmpdir(), "localscribe-root-scale-"));
      temporaryDirectories.push(resourcesPath);
      const policy = resourcePolicyFor("darwin", "arm64");
      const write = (relativePath: string, content: string): void => {
        const target = path.join(resourcesPath, ...relativePath.split("/"));
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
      };
      write(`${policy.workerDirectory}/__init__.py`, "a");
      write(`${policy.workerDirectory}/__main__.py`, "b");
      write(policy.runtimeExecutable, "python");
      for (const file of policy.helperFiles) write(file, file);
      for (const file of policy.manifestFiles) write(file, file);
      for (const file of policy.licenseFiles) write(file, file);
      for (const file of policy.brandingFiles) write(file, file);
      const runtimeRoot = path.posix.dirname(policy.runtimeExecutable);
      for (let branch = 0; branch < branches; branch += 1) {
        let directory = `${runtimeRoot}/lib/branch-${branch}`;
        for (let depth = 0; depth < 6; depth += 1) {
          directory = `${directory}/level-${depth}`;
          write(`${directory}/module.py`, `${branch}:${depth}`);
        }
      }
      return resourcesPath;
    };

    /*
     * Both trees are laid down before the counter is installed. On darwin
     * `path === path.posix`, so the patch is visible to `path.dirname` too, and
     * the fixture writer above uses it.
     */
    const smallTree = buildTree(20);
    const largeTree = buildTree(40);

    const measure = (resourcesPath: string): { calls: number; entryCount: number } => {
      const original = path.posix.dirname;
      let calls = 0;
      path.posix.dirname = (value: string): string => {
        calls += 1;
        return original(value);
      };
      try {
        const expectation = buildResourceIntegrityExpectation(resourcesPath, "darwin", "arm64");
        return { calls, entryCount: expectation.entryCount };
      } finally {
        path.posix.dirname = original;
      }
    };

    const small = measure(smallTree);
    const large = measure(largeTree);

    // Guard the counter itself: if the patch stopped being observed, `calls`
    // would be 0 and the equalities below would hold vacuously.
    expect(small.entryCount).toBeGreaterThan(100);
    expect(large.entryCount).toBeGreaterThan(small.entryCount);

    expect(small.calls).toBe(small.entryCount);
    expect(large.calls).toBe(large.entryCount);
  });
});
