import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPackagedResourceIntegrity,
  buildResourceIntegrityExpectation,
  prepareGeneratedResourceIntegrity,
  resourceIntegrityPlaceholderSource,
  verifyPackagedResourceIntegrity,
} from "../src/main/resourceIntegrity";
import { resourcePolicyFor, type PackagedPlatform } from "../src/shared/platformResourcePolicy";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "localscribe-resource-integrity-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeFixtureFile(resourcesPath: string, relativePath: string, content = relativePath): void {
  const target = path.join(resourcesPath, ...relativePath.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function makeResourceFixture(platform: PackagedPlatform, arch: "arm64" | "x64"): string {
  const resourcesPath = makeTemporaryDirectory();
  const policy = resourcePolicyFor(platform, arch);
  writeFixtureFile(resourcesPath, `${policy.workerDirectory}/__init__.py`);
  writeFixtureFile(resourcesPath, `${policy.workerDirectory}/__main__.py`);
  writeFixtureFile(resourcesPath, policy.runtimeExecutable, "python");
  for (const file of policy.helperFiles) writeFixtureFile(resourcesPath, file);
  for (const file of policy.manifestFiles) writeFixtureFile(resourcesPath, file);
  for (const file of policy.brandingFiles) writeFixtureFile(resourcesPath, file);
  return resourcesPath;
}

function makeSourceProjectFixture(platform: PackagedPlatform, arch: "arm64" | "x64"): {
  projectPath: string;
  resourcesPath: string;
} {
  const projectPath = makeTemporaryDirectory();
  const resourcesPath = path.join(projectPath, "resources");
  const policy = resourcePolicyFor(platform, arch);
  for (const file of [`${policy.workerDirectory}/__init__.py`, `${policy.workerDirectory}/__main__.py`]) {
    const workerRelativePath = file.replace(/^worker\//, "");
    writeFixtureFile(projectPath, `worker/${workerRelativePath}`, file);
  }
  writeFixtureFile(resourcesPath, policy.runtimeExecutable, "python");
  for (const file of policy.helperFiles) writeFixtureFile(resourcesPath, file);
  for (const file of policy.manifestFiles) writeFixtureFile(resourcesPath, file);
  for (const file of policy.brandingFiles) writeFixtureFile(resourcesPath, file);
  return { projectPath, resourcesPath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("packaged loose-resource integrity", () => {
  it("is deterministic and detects a byte change", () => {
    const resourcesPath = makeResourceFixture("darwin", "arm64");
    const expected = buildResourceIntegrityExpectation(resourcesPath, "darwin", "arm64");
    expect(buildResourceIntegrityExpectation(resourcesPath, "darwin", "arm64")).toEqual(expected);

    writeFixtureFile(resourcesPath, "worker/localscribe_worker/__main__.py", "tampered");
    expect(() =>
      assertPackagedResourceIntegrity(resourcesPath, "darwin", "arm64", expected),
    ).toThrow(/Resource integrity mismatch/);
  });

  it("derives source expectations from Forge's worker-plus-resources source layout", () => {
    const { projectPath, resourcesPath } = makeSourceProjectFixture("darwin", "arm64");

    const expected = buildResourceIntegrityExpectation(
      resourcesPath,
      "darwin",
      "arm64",
      projectPath,
    );
    expect(expected.platform).toBe("darwin-arm64");
    expect(expected.entryCount).toBeGreaterThan(0);
  });

  it("rejects extra and missing loose resources", () => {
    const resourcesPath = makeResourceFixture("darwin", "arm64");
    const expected = buildResourceIntegrityExpectation(resourcesPath, "darwin", "arm64");

    writeFixtureFile(resourcesPath, "worker/localscribe_worker/extra.py", "unexpected");
    expect(() =>
      assertPackagedResourceIntegrity(resourcesPath, "darwin", "arm64", expected),
    ).toThrow(/Resource integrity mismatch/);

    rmSync(path.join(resourcesPath, "worker", "localscribe_worker", "extra.py"));
    rmSync(path.join(resourcesPath, "model-manifest", "whisper-large-v3-mlx.json"));
    expect(() =>
      assertPackagedResourceIntegrity(resourcesPath, "darwin", "arm64", expected),
    ).toThrow(/missing required loose resource|Resource integrity mismatch/);
  });

  it("records symlink targets and rejects a changed target", () => {
    const resourcesPath = makeResourceFixture("darwin", "arm64");
    const runtimeDirectory = path.join(resourcesPath, "python-runtime");
    const executable = path.join(runtimeDirectory, "venv", "bin", "python3");
    writeFixtureFile(resourcesPath, "python-runtime/python-a", "a");
    writeFixtureFile(resourcesPath, "python-runtime/python-b", "b");
    unlinkSync(executable);
    symlinkSync("../../python-a", executable);
    const expected = buildResourceIntegrityExpectation(resourcesPath, "darwin", "arm64");
    expect(lstatSync(executable).isSymbolicLink()).toBe(true);

    unlinkSync(executable);
    symlinkSync("../../python-b", executable);
    expect(() =>
      assertPackagedResourceIntegrity(resourcesPath, "darwin", "arm64", expected),
    ).toThrow(/Resource integrity mismatch/);
  });

  it("rejects a symlink that escapes the protected resource tree", () => {
    const resourcesPath = makeResourceFixture("darwin", "arm64");
    const executable = path.join(resourcesPath, "python-runtime", "venv", "bin", "python3");
    unlinkSync(executable);
    symlinkSync("/tmp/not-a-bundled-python", executable);

    expect(() => buildResourceIntegrityExpectation(resourcesPath, "darwin", "arm64")).toThrow(
      /unsafe symlink/,
    );
  });

  it("rejects a Windows resource in a Mac package tree", () => {
    const resourcesPath = makeResourceFixture("darwin", "arm64");
    const expected = buildResourceIntegrityExpectation(resourcesPath, "darwin", "arm64");
    writeFixtureFile(
      resourcesPath,
      "worker/windows_transformers/localscribe_windows_worker/__main__.py",
    );

    expect(() =>
      assertPackagedResourceIntegrity(resourcesPath, "darwin", "arm64", expected),
    ).toThrow(/unexpected loose resource/);
  });

  it("restores the committed generated placeholder after preparing a package", () => {
    const resourcesPath = makeResourceFixture("win32", "x64");
    const generatedModulePath = path.join(makeTemporaryDirectory(), "generatedResourceIntegrity.ts");
    writeFileSync(generatedModulePath, resourceIntegrityPlaceholderSource);

    const prepared = prepareGeneratedResourceIntegrity({
      resourcesPath,
      platform: "win32",
      arch: "x64",
      generatedModulePath,
    });
    const generated = readFileSync(generatedModulePath, "utf8");
    expect(generated).toContain(prepared.expectation.root);
    expect(generated).not.toBe(resourceIntegrityPlaceholderSource);

    prepared.restore();
    expect(readFileSync(generatedModulePath, "utf8")).toBe(resourceIntegrityPlaceholderSource);
    expect(existsSync(generatedModulePath)).toBe(true);
  });

  it("fails closed in packaged mode and is inert during development", () => {
    const resourcesPath = makeResourceFixture("win32", "x64");
    const expected = buildResourceIntegrityExpectation(resourcesPath, "win32", "x64");
    expect(() =>
      verifyPackagedResourceIntegrity({
        isPackaged: true,
        resourcesPath,
        platform: "win32",
        arch: "x64",
        expected,
      }),
    ).not.toThrow();

    writeFixtureFile(resourcesPath, "worker/windows_transformers/localscribe_windows_worker/__main__.py", "tampered");
    expect(() =>
      verifyPackagedResourceIntegrity({
        isPackaged: true,
        resourcesPath,
        platform: "win32",
        arch: "x64",
        expected,
      }),
    ).toThrow(/Resource integrity mismatch/);
    expect(() =>
      verifyPackagedResourceIntegrity({
        isPackaged: false,
        resourcesPath,
        platform: "win32",
        arch: "x64",
        expected,
      }),
    ).not.toThrow();
  });
});
