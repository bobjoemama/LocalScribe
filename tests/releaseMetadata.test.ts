import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadReleaseMetadata,
  releaseLayout,
} from "../scripts/release-metadata.mts";
import { RELEASE_POLICY } from "../src/shared/releasePolicy.mts";

const temporaryDirectories: string[] = [];

function project(packageJson: Record<string, unknown>): string {
  const root = mkdtempSync(path.join(tmpdir(), "localscribe-release-metadata-"));
  temporaryDirectories.push(root);
  writeFileSync(path.join(root, "package.json"), JSON.stringify(packageJson));
  return root;
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "localscribe",
    productName: "LocalScribe",
    version: "2.3.4-beta.5",
    packageManager: "npm@11.16.0",
    repository: {
      type: "git",
      url: "git+https://github.com/bobjoemama/LocalScribe.git",
    },
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("release metadata", () => {
  it("derives versioned target artifacts from package metadata and stable policy", () => {
    const root = project(manifest());
    const metadata = loadReleaseMetadata(root);
    const mac = releaseLayout(metadata, "darwin", root);
    const windows = releaseLayout(metadata, "win32", root);

    expect(metadata.repository).toBe("bobjoemama/LocalScribe");
    expect(metadata.windowsAppUserModelId).toBe(
      RELEASE_POLICY.windowsAppUserModelId,
    );
    expect(metadata.targets.darwin).toMatchObject(RELEASE_POLICY.targets.darwin);
    expect(metadata.targets.win32).toMatchObject(RELEASE_POLICY.targets.win32);
    expect(mac.tag).toBe("v2.3.4-beta.5");
    expect(mac.primaryArtifactNames).toEqual([
      "LocalScribe-2.3.4-beta.5-arm64.dmg",
      "LocalScribe-darwin-arm64-2.3.4-beta.5.zip",
    ]);
    expect(mac.coreSbomName).toBe(
      "LocalScribe-2.3.4-beta.5-macos-arm64-core-runtime.sbom.cdx.json",
    );
    expect(windows.primaryArtifactNames).toEqual([
      "LocalScribe-win32-x64-2.3.4-beta.5.zip",
    ]);
    expect(windows.checksumName).toBe(
      "LocalScribe-2.3.4-beta.5-windows-x64-SHA256SUMS.txt",
    );
  });

  it("rejects malformed semantic versions and noncanonical repositories", () => {
    expect(() =>
      loadReleaseMetadata(project(manifest({ version: "1.0.0-01" }))),
    ).toThrow(/semantic version/u);
    expect(() =>
      loadReleaseMetadata(project(manifest({ version: "1.0.0-.." }))),
    ).toThrow(/semantic version/u);
    expect(() =>
      loadReleaseMetadata(project(manifest({
        repository: { url: "git@github.com:bobjoemama/LocalScribe.git" },
      }))),
    ).toThrow(/GitHub HTTPS/u);
  });

  it.each([
    "CON",
    "nul",
    "AUX.txt",
    "PRN.release",
    "COM1",
    "com9.exe",
    "LPT1",
    "lpt9.log",
  ])("rejects reserved Windows device product name %s", (productName) => {
    expect(() =>
      loadReleaseMetadata(project(manifest({ productName }))),
    ).toThrow(/reserved Windows device basename/u);
  });

  it.each(["Console", "COM0", "COM10", "LPT0", "LPT10"])(
    "accepts ordinary product name %s near the reserved-device namespace",
    (productName) => {
      expect(loadReleaseMetadata(project(manifest({ productName }))).productName).toBe(
        productName,
      );
    },
  );

  it("keeps target commands and release docs metadata-driven", () => {
    const packageJson = JSON.parse(
      readFileSync(path.resolve("package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const targetRunner = readFileSync(
      path.resolve("scripts/run-forge-target.mjs"),
      "utf8",
    );
    const releasing = readFileSync(path.resolve("docs/RELEASING.md"), "utf8");
    const readme = readFileSync(path.resolve("README.md"), "utf8");

    expect(packageJson.scripts["make:mac"]).toContain(
      "run-forge-target.mjs make darwin",
    );
    expect(packageJson.scripts["make:windows"]).toContain(
      "run-forge-target.mjs make win32",
    );
    expect(targetRunner).not.toMatch(/--arch=(?:arm64|x64)/u);
    expect(releasing).toContain("scripts/verify-release-assets.mjs `");
    expect(releasing).toContain("--platform win32 `");
    expect(releasing).toContain("--require-prerelease");
    expect(releasing).toContain("gh release upload $release.tag @assetPaths");
    expect(releasing).toContain("Do not delete or replace a reviewed asset in place.");
    expect(readme).not.toContain("/releases/download/v0.1.0");
    expect(readme).not.toContain("LocalScribe-0.1.0-arm64.dmg");
  });
});
