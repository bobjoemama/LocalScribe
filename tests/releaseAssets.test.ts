import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyReleaseAssets } from "../scripts/release-assets.mts";
import {
  loadReleaseMetadata,
  releaseLayout,
  type ReleasePlatform,
} from "../scripts/release-metadata.mts";

const temporaryDirectories: string[] = [];

function makeProject(version = "3.4.5-rc.2"): string {
  const root = mkdtempSync(path.join(tmpdir(), "localscribe-release-assets-"));
  temporaryDirectories.push(root);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "localscribe",
    productName: "LocalScribe",
    version,
    packageManager: "npm@11.16.0",
    repository: {
      type: "git",
      url: "git+https://github.com/bobjoemama/LocalScribe.git",
    },
  }));
  return root;
}

function hash(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function writeReleaseFixture(root: string, platform: ReleasePlatform): {
  checksumPath: string;
  contentPaths: readonly string[];
  readmePath: string;
} {
  const layout = releaseLayout(loadReleaseMetadata(root), platform, root);
  const contentPaths = [
    ...layout.primaryArtifactPaths,
    layout.coreSbomPath,
    layout.pythonSbomPath,
  ];
  for (const [index, filePath] of contentPaths.entries()) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      filePath.endsWith(".sbom.cdx.json")
        ? JSON.stringify({
            bomFormat: "CycloneDX",
            specVersion: "1.5",
            components: [{ type: "application", name: `component-${index}` }],
          })
        : `release-asset-${index}\n`,
    );
  }
  const rows = contentPaths.map((filePath) => {
    return `${hash(filePath)} *${path.basename(filePath)}`;
  });
  writeFileSync(layout.checksumPath, `${rows.join("\n")}\n`);

  const readmePath = path.join(root, "README.md");
  writeFileSync(
    readmePath,
    "# LocalScribe\n\nDownload SHA256SUMS.txt and run:\n\n" +
      "```sh\nshasum -a 256 -c LocalScribe-<version>-macos-arm64-SHA256SUMS.txt\n```\n",
  );

  return { checksumPath: layout.checksumPath, contentPaths, readmePath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("release asset verification", () => {
  it("verifies the exact checksummed macOS upload inventory", async () => {
      const platform = "darwin";
      const root = makeProject();
      writeReleaseFixture(root, platform);

      const result = await verifyReleaseAssets(platform, root);

      expect(result.repository).toBe("bobjoemama/LocalScribe");
      expect(result.tag).toBe("v3.4.5-rc.2");
      expect(result.prerelease).toBe(true);
      expect(result.assets).toHaveLength(5);
      expect(result.assets.at(-1)?.path).toBe(result.checksumPath);
  });

  it("rejects a checksum inventory with the wrong path casing", async () => {
    const root = makeProject();
    const { checksumPath } = writeReleaseFixture(root, "darwin");
    writeFileSync(
      checksumPath,
      readFileSync(checksumPath, "utf8").replace("LocalScribe", "localscribe"),
    );

    await expect(verifyReleaseAssets("darwin", root)).rejects.toThrow(
      /checksum does not match/u,
    );
  });

  it("rejects an asset at GitHub's two-GiB per-file limit before hashing", async () => {
    const root = makeProject();
    const { contentPaths } = writeReleaseFixture(root, "darwin");
    truncateSync(contentPaths[0]!, 2 * 1024 * 1024 * 1024);

    await expect(verifyReleaseAssets("darwin", root)).rejects.toThrow(
      /must be smaller/u,
    );
  });

  it("rejects a checksummed file that is not a valid CycloneDX SBOM", async () => {
    const root = makeProject();
    const { contentPaths, checksumPath } = writeReleaseFixture(root, "darwin");
    const coreSbom = contentPaths.find((entry) =>
      entry.endsWith("core-runtime.sbom.cdx.json")
    )!;
    writeFileSync(coreSbom, "{}");
    const rows = contentPaths.map((filePath) => {
      return `${hash(filePath)} *${path.basename(filePath)}`;
    });
    writeFileSync(checksumPath, `${rows.join("\n")}\n`);

    await expect(verifyReleaseAssets("darwin", root)).rejects.toThrow(
      /supported CycloneDX/u,
    );
  });

  it("rejects nested local build paths that would fail after flat asset download", async () => {
    const root = makeProject();
    const { checksumPath } = writeReleaseFixture(root, "darwin");
    writeFileSync(
      checksumPath,
      readFileSync(checksumPath, "utf8").replace("*LocalScribe-", "*make/LocalScribe-"),
    );

    await expect(verifyReleaseAssets("darwin", root)).rejects.toThrow(
      /flat release asset basenames/u,
    );
  });

  it("rejects a README that does not explain checksum-manifest verification", async () => {
    const root = makeProject();
    const { readmePath } = writeReleaseFixture(root, "darwin");
    writeFileSync(readmePath, "# LocalScribe\n\nDownload it and trust us.\n");

    await expect(verifyReleaseAssets("darwin", root)).rejects.toThrow(
      /README does not explain verification/u,
    );
  });

  it("does not require README publication instructions for a local candidate", async () => {
    const root = makeProject();
    const { readmePath } = writeReleaseFixture(root, "darwin");
    rmSync(readmePath);

    const result = await verifyReleaseAssets("darwin", root, "candidate");

    expect(result.platform).toBe("darwin");
    expect(result.assets).toHaveLength(5);
  });

  it("rejects a missing README", async () => {
    const root = makeProject();
    const { readmePath } = writeReleaseFixture(root, "darwin");
    rmSync(readmePath);

    await expect(verifyReleaseAssets("darwin", root)).rejects.toThrow(
      /README\.md is missing/u,
    );
  });

  it("requires the checksum command to use manifest-check mode", async () => {
    const root = makeProject();
    const { readmePath } = writeReleaseFixture(root, "darwin");
    const readme = readFileSync(readmePath, "utf8");
    writeFileSync(readmePath, readme.replace("shasum -a 256 -c", "shasum -a 256"));

    await expect(verifyReleaseAssets("darwin", root)).rejects.toThrow(
      /README does not explain verification/u,
    );
  });
});
