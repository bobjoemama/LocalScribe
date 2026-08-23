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
  const outRoot = path.join(root, "out");
  const rows = contentPaths.map((filePath) => {
    const relative = path.relative(outRoot, filePath).split(path.sep).join("/");
    return `${hash(filePath)} *${relative}`;
  });
  writeFileSync(layout.checksumPath, `${rows.join("\n")}\n`);

  /*
   * The real README tells downloaders to run exactly this command, and that
   * line is the only integrity check they are ever asked to perform. The
   * fixture has to carry it too, or the verification of it is never exercised.
   */
  const readmePath = path.join(root, "README.md");
  const sections = layout.primaryArtifactPaths.map((filePath) => [
    "```sh",
    `shasum -a 256 ${path.basename(filePath)}`,
    `# ${hash(filePath)}`,
    "```",
  ].join("\n"));
  writeFileSync(readmePath, `# LocalScribe\n\n${sections.join("\n\n")}\n`);

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

  /*
   * The README's `shasum -a 256` line is the only integrity check a downloader
   * is ever asked to run. Bumping the version once rewrote the artifact
   * filename and left the previous release's hash under it with every gate
   * green — worse than publishing no hash, because it teaches whoever does
   * check that a mismatch is normal.
   */
  it("rejects a README that documents the previous release's checksum", async () => {
    const root = makeProject();
    const { readmePath } = writeReleaseFixture(root, "darwin");
    const stale = "a".repeat(64);
    const readme = readFileSync(readmePath, "utf8");
    writeFileSync(readmePath, readme.replace(/# [0-9a-f]{64}/u, `# ${stale}`));

    await expect(verifyReleaseAssets("darwin", root)).rejects.toThrow(
      /README documents the wrong SHA-256/u,
    );
  });

  it("lets a local candidate differ from a previously published README hash", async () => {
    const root = makeProject();
    const { readmePath } = writeReleaseFixture(root, "darwin");
    const readme = readFileSync(readmePath, "utf8");
    writeFileSync(readmePath, readme.replace(/# [0-9a-f]{64}/u, `# ${"a".repeat(64)}`));

    const result = await verifyReleaseAssets("darwin", root, "candidate");

    expect(result.platform).toBe("darwin");
    expect(result.assets).toHaveLength(5);
  });

  /*
   * Without this the check passes by matching nothing, which is the same
   * silent failure wearing a different costume.
   */
  it("rejects a README that documents no checksum at all", async () => {
    const root = makeProject();
    const { readmePath } = writeReleaseFixture(root, "darwin");
    writeFileSync(readmePath, "# LocalScribe\n\nDownload it and trust us.\n");

    await expect(verifyReleaseAssets("darwin", root)).rejects.toThrow(
      /documents no verifiable SHA-256/u,
    );
  });

  it("rejects a missing README", async () => {
    const root = makeProject();
    const { readmePath } = writeReleaseFixture(root, "darwin");
    rmSync(readmePath);

    await expect(verifyReleaseAssets("darwin", root)).rejects.toThrow(
      /README\.md is missing/u,
    );
  });

  /*
   * The artifact name contains dots, which are pattern metacharacters. An
   * unescaped name would let `LocalScribe-3.4.5-rc.2-arm64.dmg` match a README
   * naming `LocalScribe-3X4X5-rcX2-arm64Xdmg`, so a genuinely wrong filename
   * would still be accepted.
   */
  it("does not treat dots in the artifact name as wildcards", async () => {
    const root = makeProject();
    const { readmePath } = writeReleaseFixture(root, "darwin");
    const readme = readFileSync(readmePath, "utf8");
    writeFileSync(readmePath, readme.replace(/shasum -a 256 (\S+)/gu, (_line, name: string) =>
      `shasum -a 256 ${name.replace(/\./gu, "X")}`));

    await expect(verifyReleaseAssets("darwin", root)).rejects.toThrow(
      /documents no verifiable SHA-256/u,
    );
  });
});
