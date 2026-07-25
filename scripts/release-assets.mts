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
): Map<string, { relativePath: string; sha256: string }> {
  const entries = new Map<string, { relativePath: string; sha256: string }>();
  for (const rawLine of readFileSync(checksumPath, "utf8").split(/\r?\n/u)) {
    if (!rawLine) continue;
    const match = /^([a-f0-9]{64}) [* ](.+)$/u.exec(rawLine);
    if (!match?.[1] || !match[2]) fail(`malformed checksum row: ${rawLine}`);
    const relativePath = match[2].replaceAll("\\", "/");
    if (
      relativePath.startsWith("/") ||
      /^[a-z]:\//iu.test(relativePath) ||
      relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      fail(`unsafe checksum path: ${relativePath}`);
    }
    const canonical = relativePath.toLowerCase();
    if (entries.has(canonical)) fail(`duplicate checksum path: ${relativePath}`);
    entries.set(canonical, { relativePath, sha256: match[1] });
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

export async function verifyReleaseAssets(
  platform: ReleasePlatform,
  projectPath = process.cwd(),
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
  const outRoot = path.resolve(projectPath, "out");
  const expectedRows = new Set<string>();
  const verified: VerifiedReleaseAsset[] = [];
  for (const asset of content) {
    const relative = path.relative(outRoot, asset.path).split(path.sep).join("/");
    if (relative.startsWith("../") || path.posix.isAbsolute(relative)) {
      fail(`asset is outside out/: ${asset.path}`);
    }
    const canonical = relative.toLowerCase();
    expectedRows.add(canonical);
    const checksumRow = checksumRows.get(canonical);
    const actualHash = sha256(asset);
    if (
      !checksumRow ||
      checksumRow.relativePath !== relative ||
      checksumRow.sha256 !== actualHash
    ) {
      fail(`checksum does not match ${relative}`);
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
