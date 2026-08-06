import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertPackagedResourceIntegrity,
  buildResourceIntegrityExpectation,
} from "../src/main/resourceIntegrity";
import { WorkerSupervisor } from "../src/main/worker/workerSupervisor";
import {
  isForbiddenPackagedResourcePath,
  resourcePolicyFor,
} from "../src/shared/platformResourcePolicy";
import { expectPrecedes, sliceBetween } from "./support/order";

/*
 * The worker ran with `-B` and `PYTHONDONTWRITEBYTECODE=1`, so CPython
 * recompiled every module on every start. Measured against the packaged
 * runtime, importing the ML stack is 1,492 modules and cost 2.11-2.86s on every
 * model load; with a warm bytecode cache the same import is 0.70-0.87s. The
 * user pays that difference on every launch that loads a model and on every
 * model switch.
 *
 * The reason it was disabled matters as much as the saving. The worker's
 * sources live in the packaged Resources tree, which is code-signed and covered
 * by the startup integrity hash, and `.pyc` is on the forbidden
 * packaged-resource list. Letting Python write `__pycache__` beside those
 * sources would add files to a protected tree and make the *next* launch fail
 * verification — turning a startup optimisation into an app that will not
 * start. So the cache is only ever allowed somewhere else.
 */

const WORKER_DIRECTORY = "/Applications/LocalScribe.app/Contents/Resources/worker";
const RUNTIME_DIRECTORY = "/Applications/LocalScribe.app/Contents/Resources/python-runtime";
const MODEL_ROOT = "/Users/example/Library/Application Support/LocalScribe/models";
const ENVIRONMENT = "/Users/example/Library/Application Support/LocalScribe/python-env";
const CACHE = "/Users/example/Library/Application Support/LocalScribe/python-bytecode-cache";

function makeSupervisor(bytecodeCacheDirectory: string | null): WorkerSupervisor {
  return new WorkerSupervisor(
    WORKER_DIRECTORY,
    MODEL_ROOT,
    ENVIRONMENT,
    RUNTIME_DIRECTORY,
    "localscribe_worker",
    null,
    bytecodeCacheDirectory,
  );
}

/** The environment builder is private; this is the only thing under test. */
function environmentOf(supervisor: WorkerSupervisor, bundled = true): NodeJS.ProcessEnv {
  return (supervisor as unknown as {
    workerEnvironment(usingBundledPython: boolean): NodeJS.ProcessEnv;
  }).workerEnvironment(bundled);
}

describe("refusing a cache that would corrupt the packaged tree", () => {
  it.each([
    ["the worker directory itself", WORKER_DIRECTORY],
    ["inside the worker directory", `${WORKER_DIRECTORY}/localscribe_worker/__pycache__`],
    ["the bundled runtime directory", RUNTIME_DIRECTORY],
    ["inside the bundled runtime", `${RUNTIME_DIRECTORY}/venv/lib/cache`],
  ])("refuses a cache at %s", (_label, directory) => {
    expect(() => makeSupervisor(directory)).toThrow(
      /must not live inside the packaged resource tree/u,
    );
  });

  it("refuses a relative cache path, which would resolve against the worker's cwd", () => {
    // The worker is spawned with `cwd` set to the worker directory, so a
    // relative cache path would land straight inside the protected tree.
    expect(() => makeSupervisor("python-bytecode-cache")).toThrow(/absolute path/u);
  });

  it("accepts a cache in the user data directory", () => {
    expect(() => makeSupervisor(CACHE)).not.toThrow();
  });

  it("accepts a sibling whose path merely starts like the protected tree", () => {
    expect(() => makeSupervisor(`${WORKER_DIRECTORY}-cache`)).not.toThrow();
  });
});

describe("what the worker process is actually told", () => {
  it("caches bytecode when a directory is configured", () => {
    const environment = environmentOf(makeSupervisor(CACHE));

    expect(environment.PYTHONPYCACHEPREFIX).toBe(CACHE);
    // Leaving this set would silently cancel the cache.
    expect(environment.PYTHONDONTWRITEBYTECODE).toBeUndefined();
  });

  /*
   * The safe default. Without a configured directory the worker must behave
   * exactly as it did before, so no code path can ever start writing into the
   * signed resource tree by omission.
   */
  it("still refuses to write bytecode at all when no directory is configured", () => {
    const environment = environmentOf(makeSupervisor(null));

    expect(environment.PYTHONDONTWRITEBYTECODE).toBe("1");
    expect(environment.PYTHONPYCACHEPREFIX).toBeUndefined();
  });

  it("keeps the rest of the worker environment unchanged", () => {
    const cached = environmentOf(makeSupervisor(CACHE));
    const uncached = environmentOf(makeSupervisor(null));

    for (const key of ["PYTHONUNBUFFERED", "PYTHONUTF8", "PYTHONIOENCODING", "PYTHONPATH"]) {
      expect(cached[key]).toBe(uncached[key]);
    }
  });
});

describe("the -B flag, which is the same switch in argument form", () => {
  const source = readFileSync("src/main/worker/workerSupervisor.ts", "utf8");
  const spawnBlock = sliceBetween(source, "const command = bundledPython ?? \"uv\";", "const child = spawn(");

  it("is dropped exactly when a cache directory is configured", () => {
    expect(spawnBlock).toContain("this.bytecodeCacheDirectory === null ? [\"-B\"] : []");
  });

  it("is applied to the packaged and the development spawn alike", () => {
    // Both paths must agree, or development would silently keep recompiling.
    expect(spawnBlock).toContain("[...noBytecode, \"-m\", this.workerModule]");
    expect(spawnBlock).toContain("\"python\", ...noBytecode, \"-m\", this.workerModule");
    expect(spawnBlock).not.toMatch(/"-B", "-m"/u);
  });
});

/*
 * Why the cache may not simply be enabled in place. This is the constraint the
 * whole design exists to satisfy, so it is asserted rather than described.
 */
describe("bytecode beside the worker sources breaks the packaged app", () => {
  it("is a forbidden packaged resource", () => {
    expect(isForbiddenPackagedResourcePath(
      "worker/localscribe_worker/__pycache__/worker.cpython-312.pyc",
    )).toBe(true);
  });

  it("makes the next launch fail its own integrity verification", () => {
    const resourcesPath = mkdtempSync(path.join(tmpdir(), "localscribe-pyc-"));
    try {
      const policy = resourcePolicyFor("darwin", "arm64");
      const write = (relativePath: string, content = relativePath): void => {
        const target = path.join(resourcesPath, ...relativePath.split("/"));
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
      };
      write(`${policy.workerDirectory}/__init__.py`);
      write(`${policy.workerDirectory}/__main__.py`);
      write(policy.runtimeExecutable, "python");
      for (const file of [...policy.helperFiles, ...policy.manifestFiles, ...policy.brandingFiles]) {
        write(file);
      }

      const expected = buildResourceIntegrityExpectation(resourcesPath, "darwin", "arm64");
      expect(() => assertPackagedResourceIntegrity(resourcesPath, "darwin", "arm64", expected))
        .not.toThrow();

      // Exactly what CPython drops beside the sources without a cache prefix.
      write(`${policy.workerDirectory}/__pycache__/__main__.cpython-312.pyc`, "bytecode");
      expect(() => assertPackagedResourceIntegrity(resourcesPath, "darwin", "arm64", expected))
        .toThrow(/unexpected loose resource/u);
    } finally {
      rmSync(resourcesPath, { recursive: true, force: true });
    }
  });
});

describe("main configures the cache", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const setup = sliceBetween(main, "const bytecodeCacheDirectory", "workerInitialized = true;");

  it("puts it under userData, not in the resource tree", () => {
    // Only the cache expression itself — the surrounding supervisor
    // construction legitimately references resourcesPath for the runtime.
    const declaration = sliceBetween(main, "const bytecodeCacheDirectory", "await mkdir(");

    expect(declaration).toContain('path.join(app.getPath("userData"), "python-bytecode-cache")');
    expect(declaration).not.toContain("process.resourcesPath");
    expect(declaration).not.toContain("getAppPath()");
  });

  it("creates the directory before the supervisor could use it", () => {
    expectPrecedes(setup, "await mkdir(bytecodeCacheDirectory", "new WorkerSupervisor(");
  });

  it("passes it to the supervisor", () => {
    expect(setup).toContain("bytecodeCacheDirectory,");
  });

  it("keeps the cache out of the integrity-protected tree by construction", () => {
    const cacheRoot = path.join("/Users/example/Library/Application Support/LocalScribe", "python-bytecode-cache");
    const relative = path.relative(WORKER_DIRECTORY, cacheRoot);

    expect(relative.startsWith("..")).toBe(true);
  });
});
