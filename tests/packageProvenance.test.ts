import { createPackage } from "@electron/asar";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertFreshViteBuild,
  assertPackagedArchive,
  buildPackageProvenance,
  writePackageProvenance,
} from "../scripts/package-provenance.mts";

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
});
