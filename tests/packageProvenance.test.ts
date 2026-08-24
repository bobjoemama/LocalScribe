import { createPackage } from "@electron/asar";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path, { resolve } from "node:path";
import { finished } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveExtractionPath,
  assertFreshViteBuild,
  assertPackagedArchive,
  buildPackageProvenance,
  normalizeArchiveEntries,
  normalizeArchiveEntry,
  releaseInputCandidates,
  writePackageProvenance,
} from "../scripts/package-provenance.mts";
import { resourcePolicyFor } from "../src/shared/platformResourcePolicy";

const temporaryDirectories: string[] = [];
const inputCandidates = ["package.json", "src"] as const;

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), `localscribe-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function writeFixtureFile(root: string, relativePath: string, content = "fixture"): void {
  const outputPath = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content);
}

function makeSourceProject(): string {
  const project = temporaryDirectory("package-source");
  writeFixtureFile(
    project,
    "package.json",
    JSON.stringify({
      name: "localscribe",
      productName: "LocalScribe",
      version: "0.1.0",
      main: ".vite/build/main.js",
    }),
  );
  writeFixtureFile(project, "src/main.ts", "export const sourceMarker = 'fresh';\n");
  writeFixtureFile(
    project,
    "src/main/generatedResourceIntegrity.ts",
    "export const generatedResourceIntegrity = { root: '' };\n",
  );
  return project;
}

async function makeArchive(
  sourceProject: string,
  mutate?: (stagingPath: string) => void,
): Promise<string> {
  const staging = temporaryDirectory("package-staging");
  const archiveRoot = temporaryDirectory("package-archive");
  const provenance = buildPackageProvenance({
    projectPath: sourceProject,
    platform: "darwin",
    arch: "arm64",
    inputCandidates,
  });
  writeFixtureFile(
    staging,
    "package.json",
    JSON.stringify({
      name: "localscribe",
      productName: "LocalScribe",
      version: "0.1.0",
      main: ".vite/build/main.js",
    }),
  );
  writeFixtureFile(staging, ".vite/build/main.js", "const main = 'packaged';\n");
  writeFixtureFile(staging, ".vite/build/preload.js", "const preload = 'packaged';\n");
  writeFixtureFile(
    staging,
    ".vite/renderer/main_window/index.html",
    '<link rel="stylesheet" href="./assets/index-a.css">' +
      '<script type="module" src="./assets/index-a.js"></script>',
  );
  writeFixtureFile(
    staging,
    ".vite/renderer/main_window/assets/index-a.js",
    'new URL("assets/pcm-worklet-a.js", import.meta.url);\n',
  );
  writeFixtureFile(
    staging,
    ".vite/renderer/main_window/assets/index-a.css",
    "body { color: black; }\n",
  );
  writeFixtureFile(
    staging,
    ".vite/renderer/main_window/assets/pcm-worklet-a.js",
    "class Processor {}\n",
  );
  writePackageProvenance(staging, provenance);
  mutate?.(staging);

  const asarPath = path.join(archiveRoot, "app.asar");
  const archiveStream = await createPackage(staging, asarPath);
  await finished(archiveStream);
  return asarPath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("package source provenance", () => {
  it("binds the Apache-2.0 license and notices into every release", () => {
    const macInputs = releaseInputCandidates("darwin");
    expect(macInputs).toEqual(expect.arrayContaining([
      "LICENSE",
      "NOTICE",
      "THIRD_PARTY_NOTICES.md",
    ]));
    expect(resourcePolicyFor("darwin", "arm64").legalFiles).toEqual([
      "LICENSE",
      "NOTICE",
      "THIRD_PARTY_NOTICES.md",
    ]);
  });

  it("binds every exact packaged FluidAudio and embedded-component notice", () => {
    const macInputs = releaseInputCandidates("darwin");
    expect(macInputs).toContain("THIRD_PARTY_NOTICES.md");
    const provenanceLicenses = macInputs
      .filter((entry) => entry.startsWith("resources/licenses/"))
      .sort();
    const packagedLicenses = resourcePolicyFor("darwin", "arm64").licenseFiles
      .map((entry) => `resources/${entry}`)
      .sort();
    expect(provenanceLicenses).toEqual(packagedLicenses);
  });

  it("binds the exact darwin/arm64 model-manifest allowlist into source provenance", () => {
    const platform = "darwin";
    const arch = "arm64";
    const provenanceManifests = releaseInputCandidates(platform)
      .filter((entry) => entry.startsWith("resources/model-manifest/"))
      .sort();
    const packagedManifests = resourcePolicyFor(platform, arch).manifestFiles
      .map((entry) => `resources/${entry}`)
      .sort();

    expect(provenanceManifests).toEqual(packagedManifests);
  });

  /*
   * A gate script that can be changed without invalidating the artifact it
   * approved is not a gate. The macOS list once bound only the worker-runtime
   * builder, so
   * `verify-local-macos.sh`, the packaged smoke, the bundle/entitlement/
   * artifact verifiers, and the SBOM generator could all be weakened while a
   * previously signed app kept reporting the same source provenance.
   */
  it("binds every script that decides whether a macOS artifact may ship", () => {
    const macInputs = releaseInputCandidates("darwin");
    const gateScripts = [
      "scripts/generate-runtime-sbom.mjs",
      "scripts/macos-entitlement-policy.mts",
      "scripts/macos-zip-preflight.mts",
      "scripts/protected-resource-staging.mts",
      "scripts/python-build-standalone.json",
      "scripts/reconcile-python-sbom.py",
      "scripts/smoke-worker.py",
      "scripts/smoke-packaged-macos.sh",
      "scripts/verify-local-macos.sh",
      "scripts/verify-local-source.mjs",
      "scripts/verify-macos-artifacts.mjs",
      "scripts/verify-macos-bundle.mjs",
      "scripts/verify-macos-entitlements.mjs",
      "scripts/verify-packaged-archive.mjs",
      "scripts/verify-packaged-main.mjs",
      "scripts/verify-release-assets.mjs",
    ];
    expect(gateScripts.filter((script) => !macInputs.includes(script))).toEqual([]);

    // Every one of them is a real file, so a rename cannot silently drop it.
    for (const script of gateScripts) {
      expect(existsSync(resolve(process.cwd(), script)), `missing ${script}`).toBe(true);
    }
  });

  it("canonicalizes POSIX and Windows ASAR entry separators identically", () => {
    expect(normalizeArchiveEntry("/.vite/build/main.js")).toBe(".vite/build/main.js");
    expect(normalizeArchiveEntry("\\.vite\\build\\main.js")).toBe(
      ".vite/build/main.js",
    );
  });

  it("converts canonical archive keys only at the native extraction boundary", () => {
    expect(archiveExtractionPath(".vite/build/main.js", "/")).toBe(
      ".vite/build/main.js",
    );
    expect(archiveExtractionPath(".vite/build/main.js", "\\")).toBe(
      ".vite\\build\\main.js",
    );
  });

  it.each([
    ["empty", ""],
    ["rooted", "/.vite/build/main.js"],
    ["backslash", ".vite\\build\\main.js"],
    ["empty segment", ".vite//build/main.js"],
    ["current-directory segment", ".vite/./build/main.js"],
    ["traversal segment", ".vite/../package.json"],
  ])("rejects %s noncanonical extraction paths", (_label, entry) => {
    expect(() => archiveExtractionPath(entry, "\\")).toThrow(
      /invalid canonical extraction path/u,
    );
  });

  it.each([
    ["missing root", ".vite/build/main.js"],
    ["empty root", "/"],
    ["doubled POSIX root", "//server/share"],
    ["doubled Windows root", "\\\\server\\share"],
    ["mixed separators", "\\.vite/build\\main.js"],
    ["empty segment", "\\.vite\\\\build\\main.js"],
    ["current-directory segment", "/.vite/./build/main.js"],
    ["traversal segment", "/.vite/../package.json"],
    ["drive or alternate-stream ambiguity", "\\C:\\app\\package.json"],
    ["control character", "/.vite/build/\u0000main.js"],
  ])("rejects %s archive entry paths", (_label, entry) => {
    expect(() => normalizeArchiveEntry(entry)).toThrow(/archive entry/);
  });

  it("rejects entries that collide after separator canonicalization", () => {
    expect(() =>
      normalizeArchiveEntries([
        "/.vite/build/main.js",
        "\\.vite\\build\\main.js",
      ], "darwin")
    ).toThrow(/duplicate canonical path \.vite\/build\/main\.js/);
  });

  it("accepts ordinary backslash-separated archive paths after canonicalization", () => {
    expect(normalizeArchiveEntries([
      "\\package.json",
      "\\.vite\\build\\main.js",
      "\\assets\\console.js",
      "\\devices\\COM10.txt",
    ], "darwin")).toEqual(new Set([
      "package.json",
      ".vite/build/main.js",
      "assets/console.js",
      "devices/COM10.txt",
    ]));
  });

  it("rejects case-insensitive aliases for portable archives", () => {
    const aliases = ["/assets/Main.js", "/assets/main.js"];
    expect(() => normalizeArchiveEntries(aliases, "darwin")).toThrow(
      /case-insensitive portable-path collision/u,
    );
  });

  it.each([
    ["/assets/trailing.", "trailing dot"],
    ["/assets/trailing ", "trailing space"],
    ["/assets/CON", "reserved bare device"],
    ["/assets/aux.txt", "reserved device with extension"],
    ["/COM1/config.json", "reserved device directory"],
    ["/assets/bad?.js", "forbidden Win32 character"],
  ])("rejects non-portable archive path with %s", (entry, _label) => {
    expect(() => normalizeArchiveEntries([entry], "darwin")).toThrow(
      /not a portable Windows path/u,
    );
  });

  it("changes when a release input changes but ignores the transient integrity module", () => {
    const project = makeSourceProject();
    const initial = buildPackageProvenance({
      projectPath: project,
      platform: "darwin",
      arch: "arm64",
      inputCandidates,
    });

    writeFixtureFile(
      project,
      "src/main/generatedResourceIntegrity.ts",
      "export const generatedResourceIntegrity = { root: 'temporary' };\n",
    );
    expect(
      buildPackageProvenance({
        projectPath: project,
        platform: "darwin",
        arch: "arm64",
        inputCandidates,
      }),
    ).toEqual(initial);

    writeFixtureFile(project, "src/main.ts", "export const sourceMarker = 'changed';\n");
    expect(
      buildPackageProvenance({
        projectPath: project,
        platform: "darwin",
        arch: "arm64",
        inputCandidates,
      }).sourceRoot,
    ).not.toBe(initial.sourceRoot);
  });

  it("requires every Vite output to be nonempty and fresh for this invocation", () => {
    const buildPath = temporaryDirectory("fresh-vite");
    for (const file of [
      ".vite/build/main.js",
      ".vite/build/preload.js",
      ".vite/renderer/main_window/index.html",
      ".vite/renderer/main_window/assets/index.js",
      ".vite/renderer/main_window/assets/index.css",
    ]) {
      writeFixtureFile(buildPath, file);
    }
    const buildStartedAtMs = Date.now() - 100;
    expect(() => assertFreshViteBuild(buildPath, buildStartedAtMs)).not.toThrow();

    const stalePath = path.join(buildPath, ".vite", "build", "main.js");
    const staleTime = new Date(buildStartedAtMs - 10_000);
    utimesSync(stalePath, staleTime, staleTime);
    expect(() => assertFreshViteBuild(buildPath, buildStartedAtMs)).toThrow(
      /stale output/,
    );
  });

  it("accepts a complete renderer tied to the current source tree", async () => {
    const project = makeSourceProject();
    const asarPath = await makeArchive(project);
    expect(() =>
      assertPackagedArchive({
        asarPath,
        projectPath: project,
        platform: "darwin",
        arch: "arm64",
        inputCandidates,
      })
    ).not.toThrow();
  });

  it("rejects missing renderer assets, source maps, and source drift", async () => {
    const project = makeSourceProject();
    const missingAsset = await makeArchive(project, (staging) => {
      writeFixtureFile(
        staging,
        ".vite/renderer/main_window/index.html",
        '<link rel="stylesheet" href="./assets/missing.css">' +
          '<script type="module" src="./assets/index-a.js"></script>',
      );
    });
    expect(() =>
      assertPackagedArchive({
        asarPath: missingAsset,
        projectPath: project,
        platform: "darwin",
        arch: "arm64",
        inputCandidates,
      })
    ).toThrow(/references missing asset/);

    const missingStylesheetAsset = await makeArchive(project, (staging) => {
      writeFixtureFile(
        staging,
        ".vite/renderer/main_window/assets/index-a.css",
        "body { background: url('./missing-background.png'); }\n",
      );
    });
    expect(() =>
      assertPackagedArchive({
        asarPath: missingStylesheetAsset,
        projectPath: project,
        platform: "darwin",
        arch: "arm64",
        inputCandidates,
      })
    ).toThrow(/stylesheet references missing asset/);

    const sourceMap = await makeArchive(project, (staging) => {
      writeFixtureFile(staging, ".vite/renderer/main_window/assets/index-a.js.map", "{}");
    });
    expect(() =>
      assertPackagedArchive({
        asarPath: sourceMap,
        projectPath: project,
        platform: "darwin",
        arch: "arm64",
        inputCandidates,
      })
    ).toThrow(/source map present/);

    const current = await makeArchive(project);
    writeFixtureFile(project, "src/main.ts", "export const sourceMarker = 'later';\n");
    expect(() =>
      assertPackagedArchive({
        asarPath: current,
        projectPath: project,
        platform: "darwin",
        arch: "arm64",
        inputCandidates,
      })
    ).toThrow(/provenance sourceRoot/);
  });

  it("reports extraction failures separately from missing archive entries", async () => {
    const project = makeSourceProject();
    const directoryInPlaceOfMain = await makeArchive(project, (staging) => {
      rmSync(path.join(staging, ".vite/build/main.js"), { force: true });
      writeFixtureFile(staging, ".vite/build/main.js/child.js");
    });

    expect(() =>
      assertPackagedArchive({
        asarPath: directoryInPlaceOfMain,
        projectPath: project,
        platform: "darwin",
        arch: "arm64",
        inputCandidates,
      })
    ).toThrow(/could not extract \.vite\/build\/main\.js/u);
  });
});
