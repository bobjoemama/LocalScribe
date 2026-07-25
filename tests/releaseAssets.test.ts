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
  const outRoot = path.join(root, "out");
  const rows = contentPaths.map((filePath) => {
    const relative = path.relative(outRoot, filePath).split(path.sep).join("/");
    return `${hash(filePath)} *${relative}`;
  });
  writeFileSync(layout.checksumPath, `${rows.join("\n")}\n`);
  return { checksumPath: layout.checksumPath, contentPaths };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("release asset verification", () => {
  it.each(["darwin", "win32"] as const)(
    "verifies the exact checksummed %s upload inventory",
    async (platform) => {
      const root = makeProject();
      writeReleaseFixture(root, platform);

      const result = await verifyReleaseAssets(platform, root);

      expect(result.repository).toBe("bobjoemama/LocalScribe");
      expect(result.tag).toBe("v3.4.5-rc.2");
      expect(result.prerelease).toBe(true);
      expect(result.assets).toHaveLength(platform === "darwin" ? 5 : 4);
      expect(result.assets.at(-1)?.path).toBe(result.checksumPath);
    },
  );

  it("rejects a checksum inventory with the wrong path casing", async () => {
    const root = makeProject();
    const { checksumPath } = writeReleaseFixture(root, "win32");
    writeFileSync(
      checksumPath,
      readFileSync(checksumPath, "utf8").replace("LocalScribe", "localscribe"),
    );

    await expect(verifyReleaseAssets("win32", root)).rejects.toThrow(
      /checksum does not match/u,
    );
  });

  it("rejects an asset at GitHub's two-GiB per-file limit before hashing", async () => {
    const root = makeProject();
    const { contentPaths } = writeReleaseFixture(root, "win32");
    truncateSync(contentPaths[0]!, 2 * 1024 * 1024 * 1024);

    await expect(verifyReleaseAssets("win32", root)).rejects.toThrow(
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
    const outRoot = path.join(root, "out");
    const rows = contentPaths.map((filePath) => {
      const relative = path.relative(outRoot, filePath).split(path.sep).join("/");
      return `${hash(filePath)} *${relative}`;
    });
    writeFileSync(checksumPath, `${rows.join("\n")}\n`);

    await expect(verifyReleaseAssets("darwin", root)).rejects.toThrow(
      /supported CycloneDX/u,
    );
  });
});
