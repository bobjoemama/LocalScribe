import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import {
  loadReleaseMetadata,
  releaseLayout,
  type ReleasePlatform,
} from "./release-metadata.mts";

const GITHUB_RELEASE_ASSET_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

export interface VerifiedReleaseAsset {
  path: string;
  name: string;
  bytes: number;
  sha256: string;
}

export interface VerifiedReleaseAssets {
  repository: string;
  tag: string;
  productName: string;
  version: string;
  prerelease: boolean;
  platform: ReleasePlatform;
  arch: string;
  checksumPath: string;
  assets: readonly VerifiedReleaseAsset[];
}

export type ReleaseAssetVerificationPurpose = "candidate" | "publication";

function fail(message: string): never {
  throw new Error(`Release asset verification failed: ${message}`);
}

function sha256(
  asset: { path: string; bytes: number },
): string {
  const descriptor = openSync(asset.path, "r");
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size !== asset.bytes) {
      fail(`asset changed before hashing: ${asset.path}`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      bytes += count;
      if (bytes > asset.bytes) fail(`asset grew while hashing: ${asset.path}`);
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor);
    if (!after.isFile() || after.size !== asset.bytes || bytes !== asset.bytes) {
      fail(`asset changed while hashing: ${asset.path}`);
    }
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function requireArtifact(filePath: string): { path: string; name: string; bytes: number } {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) fail(`missing ${resolved}`);
  const metadata = lstatSync(resolved);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size === 0) {
    fail(`asset must be a nonempty ordinary file: ${resolved}`);
  }
  if (metadata.size >= GITHUB_RELEASE_ASSET_LIMIT_BYTES) {
    fail(
      `${path.basename(resolved)} is ${metadata.size} bytes; GitHub release assets ` +
      `must be smaller than ${GITHUB_RELEASE_ASSET_LIMIT_BYTES} bytes`,
    );
  }
  return { path: resolved, name: path.basename(resolved), bytes: metadata.size };
}

function parseChecksumManifest(
  checksumPath: string,
): Map<string, { assetName: string; sha256: string }> {
  const entries = new Map<string, { assetName: string; sha256: string }>();
  for (const rawLine of readFileSync(checksumPath, "utf8").split(/\r?\n/u)) {
    if (!rawLine) continue;
    const match = /^([a-f0-9]{64}) [* ](.+)$/u.exec(rawLine);
    if (!match?.[1] || !match[2]) fail(`malformed checksum row: ${rawLine}`);
    const assetName = match[2];
    if (
      assetName === "" ||
      assetName === "." ||
      assetName === ".." ||
      assetName.includes("/") ||
      assetName.includes("\\")
    ) {
      fail(`checksum rows must use flat release asset basenames: ${assetName}`);
    }
    const canonical = assetName.toLowerCase();
    if (entries.has(canonical)) fail(`duplicate checksum asset name: ${assetName}`);
    entries.set(canonical, { assetName, sha256: match[1] });
  }
  return entries;
}

function requireCycloneDxSbom(filePath: string): void {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    fail(`SBOM is not valid JSON: ${filePath}`);
  }
  const sbom = document as {
    bomFormat?: unknown;
    specVersion?: unknown;
    components?: unknown;
  };
  if (
    sbom.bomFormat !== "CycloneDX" ||
    typeof sbom.specVersion !== "string" ||
    !/^1\.\d+$/u.test(sbom.specVersion) ||
    !Array.isArray(sbom.components) ||
    sbom.components.length === 0
  ) {
    fail(`SBOM is not a nonempty supported CycloneDX document: ${filePath}`);
  }
}

/**
 * Checks the SHA-256 the README tells people to compare against.
 *
 * That line is the only integrity check a downloader is ever asked to perform,
 * and nothing verified it. Bumping the version rewrote the artifact filename in
 * the README and left the *previous* release's hash sitting under it, with
 * every gate green — which is worse than publishing no hash at all: it teaches
 * whoever does check that a mismatch is normal.
 *
 * The README is prose, so this is anchored to the exact `shasum -a 256 <name>`
 * command it documents rather than to any hash-shaped text elsewhere in it.
 */
function requireDocumentedChecksums(
  projectPath: string,
  verified: readonly VerifiedReleaseAsset[],
): void {
  const readmePath = path.join(projectPath, "README.md");
  if (!existsSync(readmePath)) fail("README.md is missing");
  const readme = readFileSync(readmePath, "utf8");

  let documented = 0;
  for (const asset of verified) {
    /*
     * The filename carries a version with dots, so it has to be escaped before
     * it goes anywhere near a pattern.
     */
    const escaped = asset.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const command = new RegExp(
      `shasum\\s+-a\\s+256\\s+${escaped}\\s*\\n\\s*#\\s*([0-9a-f]{64})\\b`,
      "u",
    );
    const match = command.exec(readme);
    if (!match?.[1]) continue;
    documented += 1;
    if (match[1] !== asset.sha256) {
      fail(
        `README documents the wrong SHA-256 for ${asset.name}: ` +
        `it says ${match[1]}, the artifact is ${asset.sha256}`,
      );
    }
  }

  /*
   * Without this the check passes by matching nothing — exactly what happens if
   * the README stops naming the artifact, which is the same silent failure in a
   * different costume.
   */
  if (documented === 0) {
    fail("README documents no verifiable SHA-256 for any release artifact");
  }
}

export async function verifyReleaseAssets(
  platform: ReleasePlatform,
  projectPath = process.cwd(),
  purpose: ReleaseAssetVerificationPurpose = "publication",
): Promise<VerifiedReleaseAssets> {
  const metadata = loadReleaseMetadata(projectPath);
  const layout = releaseLayout(metadata, platform, projectPath);
  const contentPaths = [
    ...layout.primaryArtifactPaths,
    layout.coreSbomPath,
    layout.pythonSbomPath,
  ];
  const content = contentPaths.map(requireArtifact);
  requireCycloneDxSbom(layout.coreSbomPath);
  requireCycloneDxSbom(layout.pythonSbomPath);
  const checksum = requireArtifact(layout.checksumPath);
  const checksumRows = parseChecksumManifest(checksum.path);
  const expectedRows = new Set<string>();
  const verified: VerifiedReleaseAsset[] = [];
  for (const asset of content) {
    const canonical = asset.name.toLowerCase();
    if (expectedRows.has(canonical)) fail(`release assets collide by basename: ${asset.name}`);
    expectedRows.add(canonical);
    const checksumRow = checksumRows.get(canonical);
    const actualHash = sha256(asset);
    if (
      !checksumRow ||
      checksumRow.assetName !== asset.name ||
      checksumRow.sha256 !== actualHash
    ) {
      fail(`checksum does not match ${asset.name}`);
    }
    verified.push({ ...asset, sha256: actualHash });
  }
  const unexpectedRows = [...checksumRows.keys()].filter((entry) => !expectedRows.has(entry));
  const missingRows = [...expectedRows].filter((entry) => !checksumRows.has(entry));
  if (unexpectedRows.length > 0 || missingRows.length > 0) {
    fail(
      `checksum inventory differs from release assets; ` +
      `missing [${missingRows.join(", ")}], unexpected [${unexpectedRows.join(", ")}]`,
    );
  }
  /*
   * A normal local gate verifies a newly-created candidate. DMGs contain
   * filesystem and signing metadata and are not byte-reproducible, so a fresh
   * build cannot honestly be required to equal the checksum of an older,
   * already-published artifact from the same commit. Publication verification
   * is the separate boundary that proves the README names the exact bytes a
   * downloader receives.
   */
  if (purpose === "publication") requireDocumentedChecksums(projectPath, verified);
  verified.push({
    ...checksum,
    sha256: sha256(checksum),
  });
  return {
    repository: metadata.repository,
    tag: layout.tag,
    productName: metadata.productName,
    version: metadata.version,
    prerelease: metadata.version.includes("-"),
    platform,
    arch: layout.target.arch,
    checksumPath: checksum.path,
    assets: verified,
  };
}
