import { readFileSync } from "node:fs";
import path from "node:path";
import { RELEASE_POLICY } from "../src/shared/releasePolicy.mts";

export type ReleasePlatform = "darwin" | "win32";

interface RawPackageJson {
  name?: unknown;
  productName?: unknown;
  version?: unknown;
  packageManager?: unknown;
  repository?: unknown;
}

export interface ReleaseTarget {
  platform: ReleasePlatform;
  arch: "arm64" | "x64";
  label: string;
}

export interface ReleaseMetadata {
  packageName: string;
  productName: string;
  version: string;
  packageManager: string;
  repository: string;
  macBundleId: string;
  windowsAppUserModelId: string;
  minimumMacOSVersion: string;
  targets: Readonly<Record<ReleasePlatform, ReleaseTarget>>;
}

export interface ReleaseLayout {
  target: ReleaseTarget;
  packageDirectoryName: string;
  packageDirectory: string;
  applicationName: string;
  applicationPath: string;
  makerDirectory: string;
  primaryArtifactNames: readonly string[];
  primaryArtifactPaths: readonly string[];
  coreSbomName: string;
  coreSbomPath: string;
  pythonSbomName: string;
  pythonSbomPath: string;
  checksumName: string;
  checksumPath: string;
  tag: string;
}

const EXACT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const WINDOWS_RESERVED_DEVICE_BASENAME =
  /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u;
const MAC_VERSION = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){1,2}$/u;

function fail(message: string): never {
  throw new Error(`Release metadata is invalid: ${message}`);
}

function requireSafeName(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_NAME.test(value)) {
    fail(`${label} must be a filesystem-safe nonempty name`);
  }
  if (WINDOWS_RESERVED_DEVICE_BASENAME.test(value)) {
    fail(`${label} must not use a reserved Windows device basename`);
  }
  return value;
}

function repositorySlug(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("url" in value) ||
    typeof value.url !== "string"
  ) {
    fail("package.json repository.url is required");
  }
  const match =
    /^git\+https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(
      value.url,
    );
  if (!match?.[1]) fail("repository.url must be an exact GitHub HTTPS repository URL");
  return match[1];
}

function target(
  platform: ReleasePlatform,
  raw: unknown,
  expectedArch: "arm64" | "x64",
  expectedLabel: string,
): ReleaseTarget {
  if (typeof raw !== "object" || raw === null) fail(`missing ${platform} target`);
  const candidate = raw as { arch?: unknown; label?: unknown };
  if (candidate.arch !== expectedArch || candidate.label !== expectedLabel) {
    fail(
      `${platform} target must remain the deliberate supported policy ` +
      `${expectedArch}/${expectedLabel}`,
    );
  }
  return { platform, arch: expectedArch, label: expectedLabel };
}

export function loadReleaseMetadata(projectPath = process.cwd()): ReleaseMetadata {
  const packageJsonPath = path.join(path.resolve(projectPath), "package.json");
  const raw = JSON.parse(readFileSync(packageJsonPath, "utf8")) as RawPackageJson;
  const packageName = requireSafeName(raw.name, "name");
  const productName = requireSafeName(raw.productName, "productName");
  if (typeof raw.version !== "string" || !EXACT_SEMVER.test(raw.version)) {
    fail("version must be an exact semantic version");
  }
  if (
    typeof raw.packageManager !== "string" ||
    !/^npm@\d+\.\d+\.\d+$/u.test(raw.packageManager)
  ) {
    fail("packageManager must be an exact npm version");
  }
  if (!BUNDLE_ID.test(RELEASE_POLICY.macBundleId)) {
    fail("macBundleId is malformed");
  }
  if (!BUNDLE_ID.test(RELEASE_POLICY.windowsAppUserModelId)) {
    fail("windowsAppUserModelId is malformed");
  }
  if (!MAC_VERSION.test(RELEASE_POLICY.minimumMacOSVersion)) {
    fail("minimumMacOSVersion is malformed");
  }
  return {
    packageName,
    productName,
    version: raw.version,
    packageManager: raw.packageManager,
    repository: repositorySlug(raw.repository),
    macBundleId: RELEASE_POLICY.macBundleId,
    windowsAppUserModelId: RELEASE_POLICY.windowsAppUserModelId,
    minimumMacOSVersion: RELEASE_POLICY.minimumMacOSVersion,
    targets: {
      darwin: target(
        "darwin",
        RELEASE_POLICY.targets.darwin,
        "arm64",
        "macos-arm64",
      ),
      win32: target(
        "win32",
        RELEASE_POLICY.targets.win32,
        "x64",
        "windows-x64",
      ),
    },
  };
}

export function releaseLayout(
  metadata: ReleaseMetadata,
  platform: ReleasePlatform,
  projectPath = process.cwd(),
): ReleaseLayout {
  const project = path.resolve(projectPath);
  const target = metadata.targets[platform];
  const packageDirectoryName =
    `${metadata.productName}-${target.platform}-${target.arch}`;
  const packageDirectory = path.join(project, "out", packageDirectoryName);
  const applicationName = platform === "darwin"
    ? `${metadata.productName}.app`
    : `${metadata.productName}.exe`;
  const applicationPath = path.join(packageDirectory, applicationName);
  const makerDirectory = platform === "darwin"
    ? path.join(project, "out", "make")
    : path.join(project, "out", "make", "zip", "win32", target.arch);
  const primaryArtifactNames = platform === "darwin"
    ? [
        `${metadata.productName}-${metadata.version}-${target.arch}.dmg`,
        `${packageDirectoryName}-${metadata.version}.zip`,
      ]
    : [`${packageDirectoryName}-${metadata.version}.zip`];
  const primaryArtifactPaths = primaryArtifactNames.map((name, index) =>
    platform === "darwin" && index === 1
      ? path.join(project, "out", "make", "zip", "darwin", target.arch, name)
      : path.join(makerDirectory, name)
  );
  const prefix = `${metadata.productName}-${metadata.version}-${target.label}`;
  const coreSbomName = `${prefix}-core-runtime.sbom.cdx.json`;
  const pythonSbomName = `${prefix}-python.sbom.cdx.json`;
  const checksumName = `${prefix}-SHA256SUMS.txt`;
  return {
    target,
    packageDirectoryName,
    packageDirectory,
    applicationName,
    applicationPath,
    makerDirectory,
    primaryArtifactNames,
    primaryArtifactPaths,
    coreSbomName,
    coreSbomPath: path.join(project, "out", coreSbomName),
    pythonSbomName,
    pythonSbomPath: path.join(project, "out", pythonSbomName),
    checksumName,
    checksumPath: path.join(project, "out", checksumName),
    tag: `v${metadata.version}`,
  };
}
