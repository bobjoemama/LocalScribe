import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPlatformResourceEntries,
  assertPackagedNativeModuleTargets,
  assertProductionPackageEntries,
  prunePackagedNativeModules,
  prunePackagedResources,
  productionDependencyClosure,
  pruneStagedNodeModules,
  resourcePolicyFor,
} from "../scripts/package-inventory";

const temporaryDirectories: string[] = [];
const MAC_MODEL_MANIFESTS = [
  "canary-qwen-2-5b-gguf-bf16.json",
  "canary-qwen-2-5b-gguf-q8.json",
  "canary-qwen-2-5b-gguf-q4.json",
  "whisper-large-v3-mlx.json",
  "qwen3-asr-1-7b-mlx-bf16.json",
  "qwen3-asr-1-7b-mlx-8bit.json",
  "qwen3-asr-1-7b-mlx-4bit.json",
  "qwen3-asr-0-6b-mlx-bf16.json",
  "qwen3-asr-0-6b-mlx-8bit.json",
  "qwen3-asr-0-6b-mlx-4bit.json",
  "parakeet-unified-en-0-6b-coreml-fp16.json",
  "parakeet-unified-en-0-6b-coreml-int8.json",
] as const;

function makeTemporaryProject(): string {
  const project = mkdtempSync(path.join(tmpdir(), "localscribe-package-inventory-"));
  temporaryDirectories.push(project);
  return project;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeModule(project: string, name: string, manifest: Record<string, unknown> = {}): void {
  writeJson(path.join(project, "node_modules", ...name.split("/"), "package.json"), {
    name,
    version: "1.0.0",
    ...manifest,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("packaged dependency inventory", () => {
  it("ships the byte-exact notices from pinned FluidAudio 0.15.5", () => {
    const expectedNotices = new Map([
      [
        "FluidAudio-0.15.5-LICENSE.txt",
        "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
      ],
      [
        "FluidAudio-0.15.5-fastcluster-LICENSE.md",
        "67594dbe4a7477719c8160373e7767c2c319ef966a6042f76846a18af02cde0a",
      ],
      [
        "FluidAudio-0.15.5-vbx-LICENSE.md",
        "08e57fdb5187c816e937916f1e176aadb400ca76f4b3b493d69730ec8f10dd80",
      ],
    ]);

    for (const [filename, expectedDigest] of expectedNotices) {
      const notice = readFileSync(path.resolve("resources/licenses", filename));
      expect(createHash("sha256").update(notice).digest("hex"), filename).toBe(
        expectedDigest,
      );
    }
  });

  it("keeps only the dependency closure rooted at production dependencies", () => {
    const project = makeTemporaryProject();
    writeJson(path.join(project, "package.json"), {
      dependencies: { "runtime-a": "1.0.0" },
      devDependencies: { "build-tool": "1.0.0", "@build/tool": "1.0.0" },
    });
    writeModule(project, "runtime-a", { dependencies: { "runtime-b": "1.0.0" } });
    writeModule(project, "runtime-b");
    writeModule(project, "build-tool");

    expect([...productionDependencyClosure(project)].sort()).toEqual(["runtime-a", "runtime-b"]);
  });

  it("rejects developer modules and Vite/npm caches from a release archive", () => {
    const productionModules = new Set(["better-sqlite3", "uiohook-napi", "node-addon-api", "node-gyp-build", "zod"]);
    expect(() =>
      assertProductionPackageEntries(
        [
          "/node_modules/better-sqlite3/package.json",
          "/node_modules/uiohook-napi/package.json",
          "/node_modules/zod/package.json",
          "/node_modules/@electron-forge/cli/package.json",
          "/node_modules/.bin/vite",
          "/node_modules/.vite/deps/react.js",
        ],
        productionModules,
      ),
    ).toThrow(/@electron-forge\/cli/);
  });

  it("prunes staged development modules after Vite restores the app manifest", async () => {
    const project = makeTemporaryProject();
    writeJson(path.join(project, "package.json"), {
      name: "staged-app",
      version: "1.0.0",
      main: ".vite/build/main.js",
      author: "Devesh",
      license: "SEE LICENSE IN LICENSE",
      dependencies: { "better-sqlite3": "1.0.0", "uiohook-napi": "1.0.0" },
      devDependencies: { "build-tool": "1.0.0" },
      scripts: { package: "build-tool" },
      config: { forge: { plugin: "build-tool" } },
    });
    writeModule(project, "better-sqlite3");
    writeModule(project, "uiohook-napi");
    writeModule(project, "build-tool");
    writeModule(project, "@build/tool");
    writeFileSync(path.join(project, "node_modules", ".package-lock.json"), "{}");
    mkdirSync(path.join(project, "node_modules", ".bin"), { recursive: true });
    writeFileSync(path.join(project, "node_modules", ".bin", "build-tool"), "#!/bin/sh\n");
    mkdirSync(path.join(project, "node_modules", ".vite", "deps"), { recursive: true });
    writeFileSync(path.join(project, "node_modules", ".vite", "deps", "cache.js"), "cache");
    mkdirSync(path.join(project, "node_modules", "better-sqlite3", "tests"), { recursive: true });
    writeFileSync(path.join(project, "node_modules", "better-sqlite3", "tests", "fixture.js"), "test");
    writeFileSync(path.join(project, "node_modules", "uiohook-napi", "index.js.map"), "{}");

    await pruneStagedNodeModules(project);

    expect(existsSync(path.join(project, "node_modules", "build-tool"))).toBe(false);
    expect(existsSync(path.join(project, "node_modules", "@build"))).toBe(false);
    expect(existsSync(path.join(project, "node_modules", ".bin"))).toBe(false);
    expect(existsSync(path.join(project, "node_modules", ".vite"))).toBe(false);
    expect(existsSync(path.join(project, "node_modules", "better-sqlite3", "tests"))).toBe(false);
    expect(existsSync(path.join(project, "node_modules", "uiohook-napi", "index.js.map"))).toBe(false);

    const stagedManifest = JSON.parse(readFileSync(path.join(project, "package.json"), "utf8")) as Record<string, unknown>;
    expect(stagedManifest).toMatchObject({
      name: "staged-app",
      version: "1.0.0",
      main: ".vite/build/main.js",
      author: "Devesh",
      license: "SEE LICENSE IN LICENSE",
      dependencies: { "better-sqlite3": "1.0.0", "uiohook-napi": "1.0.0" },
    });
    expect(stagedManifest).not.toHaveProperty("devDependencies");
    expect(stagedManifest).not.toHaveProperty("scripts");
    expect(stagedManifest).not.toHaveProperty("config");
  });

  it("defines the exact Apple Silicon macOS runtime policy", () => {
    const mac = resourcePolicyFor("darwin", "arm64");

    expect(mac.manifestFiles).toEqual(
      MAC_MODEL_MANIFESTS.map((filename) => `model-manifest/${filename}`),
    );
    expect(mac.workerDirectory).toBe("worker/localscribe_worker");
    expect(mac.runtimeDirectory).toBe("python-runtime");
    expect(mac.helperFiles).toEqual([
      "native/macos/active-target",
      "native/macos/localscribe-fluidaudio-parakeet",
      "native/macos/liblocalscribe-canary.dylib",
    ]);
    expect(mac.licenseFiles).toEqual([
      "licenses/transcribe-cpp-LICENSE.txt",
      "licenses/transcribe-cpp-ggml-LICENSE.txt",
      "licenses/transcribe-cpp-miniz-LICENSE.txt",
      "licenses/FluidAudio-0.15.5-LICENSE.txt",
      "licenses/FluidAudio-0.15.5-fastcluster-LICENSE.md",
      "licenses/FluidAudio-0.15.5-vbx-LICENSE.md",
    ]);
    expect(mac.brandingFiles).toEqual([]);
    expect(mac.legalFiles).toEqual(["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]);
  });

  it("keeps the source inventory and macOS allowlist to the exact curated manifests", () => {
    const sourceManifests = readdirSync(path.resolve("resources/model-manifest"))
      .filter((entry) => entry.endsWith(".json"))
      .sort();

    expect(sourceManifests).toEqual([...MAC_MODEL_MANIFESTS].sort());
    expect(resourcePolicyFor("darwin", "arm64").manifestFiles).toEqual(
      MAC_MODEL_MANIFESTS.map((filename) => `model-manifest/${filename}`),
    );
  });

  it("accepts a complete Mac allowlist and rejects Windows or development resources", () => {
    const valid = [
      "native/macos/liblocalscribe-canary.dylib",
      "licenses/transcribe-cpp-LICENSE.txt",
      "licenses/transcribe-cpp-ggml-LICENSE.txt",
      "licenses/transcribe-cpp-miniz-LICENSE.txt",
      "worker/localscribe_worker/__init__.py",
      "worker/localscribe_worker/__main__.py",
      "python-runtime/venv/bin/python3",
      "native/macos/active-target",
      "native/macos/localscribe-fluidaudio-parakeet",
      "licenses/FluidAudio-0.15.5-LICENSE.txt",
      "licenses/FluidAudio-0.15.5-fastcluster-LICENSE.md",
      "licenses/FluidAudio-0.15.5-vbx-LICENSE.md",
      "LICENSE",
      "NOTICE",
      "THIRD_PARTY_NOTICES.md",
      ...MAC_MODEL_MANIFESTS.map((filename) => `model-manifest/${filename}`),
    ];
    expect(() => assertPlatformResourceEntries(valid, "darwin", "arm64")).not.toThrow();
    expect(() =>
      assertPlatformResourceEntries(
        [
          ...valid,
          "model-manifest/faster-whisper-large-v2.json",
          "worker/windows_transformers/tests/test_worker.py",
          "native/windows/build.ps1",
        ],
        "darwin",
        "arm64",
      ),
    ).toThrow(/model-manifest inventory|unsupported-platform/);
    expect(() =>
      assertPlatformResourceEntries(
        [...valid, "licenses/unreviewed-LICENSE.txt"],
        "darwin",
        "arm64",
      ),
    ).toThrow(/license inventory/);
    expect(() =>
      assertPlatformResourceEntries(
        [...valid, "python-runtime/venv/lib/python3.12/site-packages/model/weights.npz"],
        "darwin",
        "arm64",
      ),
    ).toThrow(/weights\.npz/);
  });

  it("removes unused Python installers from base and venv trees without removing inference packages", () => {
    const resources = makeTemporaryProject();
    const policy = resourcePolicyFor("darwin", "arm64");
    const valid = [
      `${policy.workerDirectory}/__init__.py`,
      `${policy.workerDirectory}/__main__.py`,
      policy.runtimeExecutable,
      ...policy.helperFiles, ...policy.manifestFiles, ...policy.licenseFiles, ...policy.legalFiles,
      "python-runtime/cpython-3.12/bin/python3",
      "python-runtime/venv/lib/python3.12/site-packages/mlx/__init__.py",
      "python-runtime/venv/lib/python3.12/site-packages/mlx-1.0.dist-info/METADATA",
      "python-runtime/venv/lib/python3.12/site-packages/pipelines/__init__.py",
      "python-runtime/venv/lib/python3.12/site-packages/pip_api/__init__.py",
    ];
    const forbidden = [
      "python-runtime/cpython-3.12/lib/python3.12/site-packages/pip/__init__.py",
      "python-runtime/cpython-3.12/lib/python3.12/site-packages/pip-26.1.dist-info/METADATA",
      "python-runtime/cpython-3.12/lib/python3.12/ensurepip/_bundled/pip-25.0.1-py3-none-any.whl",
      "python-runtime/cpython-3.12/bin/pip",
      "python-runtime/cpython-3.12/bin/pip3",
      "python-runtime/cpython-3.12/bin/pip3.12",
      "python-runtime/venv/lib/python3.12/site-packages/pip/__init__.py",
      "python-runtime/venv/lib/python3.12/site-packages/pip-26.1.dist-info/METADATA",
      "python-runtime/venv/lib/python3.12/pip-25.0.1-py3-none-any.whl",
    ];
    for (const file of forbidden) {
      expect(() => assertPlatformResourceEntries([...valid, file], "darwin", "arm64"))
        .toThrow(/forbidden/);
    }
    for (const file of [...valid, ...forbidden]) {
      const target = path.join(resources, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file);
    }
    prunePackagedResources(resources, "darwin", "arm64");
    for (const file of forbidden) expect(existsSync(path.join(resources, file)), file).toBe(false);
    for (const file of valid) expect(existsSync(path.join(resources, file)), file).toBe(true);
    expect(() => assertPlatformResourceEntries(valid, "darwin", "arm64")).not.toThrow();
  });

  it("reduces copied resources to one operating system before signing", () => {
    const resources = makeTemporaryProject();
    const files = [
      "worker/localscribe_worker/__init__.py",
      "worker/localscribe_worker/__main__.py",
      "worker/windows_transformers/tests/test_worker.py",
      ...MAC_MODEL_MANIFESTS.map((filename) => `model-manifest/${filename}`),
      "model-manifest/faster-whisper-large-v2.json",
      "model-manifest/faster-whisper-large-v3.json",
      "native/macos/active-target",
      "native/macos/localscribe-fluidaudio-parakeet",
      "native/macos/active-target.swift",
      "native/windows/active-target.exe",
      "licenses/FluidAudio-0.15.5-LICENSE.txt",
      "licenses/FluidAudio-0.15.5-fastcluster-LICENSE.md",
      "licenses/FluidAudio-0.15.5-vbx-LICENSE.md",
      "licenses/unreviewed-LICENSE.txt",
      "python-runtime/venv/bin/python3",
      "python-runtime/venv/lib/pkg/tests/test_pkg.py",
      "python-runtime/venv/lib/pkg/cache.pyc",
      "python-runtime-windows/README.md",
    ];
    for (const file of files) {
      mkdirSync(path.dirname(path.join(resources, file)), { recursive: true });
      writeFileSync(path.join(resources, file), "fixture");
    }

    prunePackagedResources(resources, "darwin", "arm64");

    expect(existsSync(path.join(resources, "worker", "windows_transformers"))).toBe(false);
    expect(existsSync(path.join(resources, "model-manifest", "faster-whisper-large-v3.json"))).toBe(false);
    expect(existsSync(path.join(resources, "model-manifest", "faster-whisper-large-v2.json"))).toBe(false);
    expect(readdirSync(path.join(resources, "model-manifest")).sort()).toEqual(
      [...MAC_MODEL_MANIFESTS].sort(),
    );
    expect(existsSync(path.join(resources, "native", "macos", "active-target.swift"))).toBe(false);
    expect(existsSync(path.join(resources, "native", "macos", "localscribe-fluidaudio-parakeet"))).toBe(true);
    expect(existsSync(path.join(resources, "native", "windows"))).toBe(false);
    expect(readdirSync(path.join(resources, "licenses")).sort()).toEqual([
      "FluidAudio-0.15.5-LICENSE.txt",
      "FluidAudio-0.15.5-fastcluster-LICENSE.md",
      "FluidAudio-0.15.5-vbx-LICENSE.md",
    ]);
    expect(existsSync(path.join(resources, "python-runtime", "venv", "lib", "pkg", "tests"))).toBe(false);
    expect(existsSync(path.join(resources, "python-runtime-windows"))).toBe(false);
  });

  it("keeps only darwin/arm64 native npm binaries", () => {
    const platform = "darwin";
    const arch = "arm64";
    const resources = makeTemporaryProject();
    const unpacked = path.join(resources, "app.asar.unpacked", "node_modules");
    const files = [
      "better-sqlite3/prebuilds/darwin-arm64.node",
      "better-sqlite3/prebuilds/darwin-x64.node",
      "better-sqlite3/prebuilds/linux-x64.node",
      "better-sqlite3/prebuilds/win32-x64.node",
      "uiohook-napi/bin/darwin-arm64-148/uiohook-napi.node",
      "uiohook-napi/build/Release/uiohook_napi.node",
      "uiohook-napi/prebuilds/darwin-arm64/uiohook-napi.node",
      "uiohook-napi/prebuilds/linux-x64/uiohook-napi.node",
      "uiohook-napi/prebuilds/win32-x64/uiohook-napi.node",
    ];
    for (const file of files) {
      mkdirSync(path.dirname(path.join(unpacked, file)), { recursive: true });
      writeFileSync(path.join(unpacked, file), "fixture");
    }

    prunePackagedNativeModules(resources, platform, arch);
    expect(() =>
      assertPackagedNativeModuleTargets(resources, platform, arch)
    ).not.toThrow();

    const remainingNativeBinaries = readdirSync(
      path.join(unpacked, "better-sqlite3", "prebuilds"),
    );
    expect(remainingNativeBinaries).toEqual([`${platform}-${arch}.node`]);
    expect(existsSync(path.join(unpacked, "uiohook-napi", "bin"))).toBe(false);
    expect(
      existsSync(
        path.join(
          unpacked,
          "uiohook-napi",
          "prebuilds",
          `${platform}-${arch}`,
          "uiohook-napi.node",
        ),
      ),
    ).toBe(true);
  });


});
