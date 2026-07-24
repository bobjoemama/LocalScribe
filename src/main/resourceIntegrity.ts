import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { generatedResourceIntegrity } from "./generatedResourceIntegrity";
import {
  isForbiddenPackagedResourcePath,
  resourcePolicyFor,
  type PackagedPlatform,
} from "../shared/platformResourcePolicy";

const RESOURCE_INTEGRITY_DOMAIN = "localscribe-resource-integrity-v1";
const MAX_RESOURCE_TREE_ENTRIES = 100_000;
const MAX_RESOURCE_TREE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_SYMLINK_TARGET_BYTES = 4 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;
const GENERATED_MODULE_PLACEHOLDER = `// This committed placeholder is replaced only while Forge prepares a package.\n// The generated value is bundled into app.asar, then this exact file is restored.\nexport const generatedResourceIntegrity = {\n  root: "",\n  entryCount: 0,\n  coveredRoots: [],\n  platform: "",\n} as const;\n`;

type TreeEntryType = "directory" | "file" | "symlink";
type ResourceIntegrityPlatform = "darwin-arm64" | "win32-x64";
type ScanMode = "source" | "packaged";

interface ResourceTreeEntry {
  relativePath: string;
  type: TreeEntryType;
  size: number;
  contentHash: string;
  symlinkTarget?: string;
  absolutePath: string;
}

export interface ResourceIntegrityExpectation {
  root: string;
  entryCount: number;
  coveredRoots: readonly string[];
  platform: ResourceIntegrityPlatform;
}

export interface PreparedResourceIntegrity {
  expectation: ResourceIntegrityExpectation;
  restore(): void;
}

export interface ResourceIntegrityVerificationOptions {
  isPackaged: boolean;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  expected?: ResourceIntegrityExpectation;
}

interface IntegrityDescriptor {
  platform: ResourceIntegrityPlatform;
  coveredRoots: readonly string[];
  includedFiles: ReadonlySet<string>;
  recursiveRoots: readonly string[];
}

let activePreparation: PreparedResourceIntegrity | null = null;
let restoreOnProcessExitInstalled = false;

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Deliberately locale-independent ordering for reproducible package roots. */
function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hashFile(filePath: string, expectedSize: number): string {
  if (expectedSize > MAX_RESOURCE_TREE_BYTES) {
    throw new Error(`Resource integrity rejected oversized file: ${filePath}`);
  }
  const descriptor = openSync(filePath, "r");
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size !== expectedSize) {
      throw new Error(`Resource integrity detected a changing file: ${filePath}`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let totalRead = 0;
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      totalRead += bytesRead;
      if (totalRead > expectedSize) {
        throw new Error(`Resource integrity detected a changing file: ${filePath}`);
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = fstatSync(descriptor);
    if (!after.isFile() || totalRead !== expectedSize || after.size !== expectedSize) {
      throw new Error(`Resource integrity detected a changing file: ${filePath}`);
    }
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function packagedPlatformFor(platform: NodeJS.Platform, arch: string): PackagedPlatform {
  if (platform === "darwin" || platform === "win32") {
    resourcePolicyFor(platform, arch);
    return platform;
  }
  throw new Error(`Resource integrity is unsupported on ${platform}/${arch}`);
}

function descriptorFor(platform: PackagedPlatform, arch: string): IntegrityDescriptor {
  const policy = resourcePolicyFor(platform, arch);
  const includedFiles = new Set([
    ...policy.helperFiles,
    ...policy.manifestFiles,
    ...policy.brandingFiles,
  ]);
  const coveredRoots = [
    policy.workerDirectory,
    policy.runtimeDirectory,
    ...includedFiles,
  ].sort();
  return {
    platform: `${policy.platform}-${policy.arch}` as ResourceIntegrityPlatform,
    coveredRoots,
    includedFiles,
    recursiveRoots: [policy.workerDirectory, policy.runtimeDirectory],
  };
}

function isWithin(relativePath: string, root: string): boolean {
  return relativePath === root || relativePath.startsWith(`${root}/`);
}

function isParentOfIncludedFile(relativePath: string, includedFiles: ReadonlySet<string>): boolean {
  for (const file of includedFiles) {
    if (file.startsWith(`${relativePath}/`)) return true;
  }
  return false;
}

function isExpectedResourcePath(relativePath: string, descriptor: IntegrityDescriptor): boolean {
  if (descriptor.recursiveRoots.some((root) => isWithin(relativePath, root))) {
    return !isForbiddenPackagedResourcePath(relativePath);
  }
  return descriptor.includedFiles.has(relativePath) ||
    isParentOfIncludedFile(relativePath, descriptor.includedFiles) ||
    descriptor.recursiveRoots.some((root) => root.startsWith(`${relativePath}/`));
}

function isCandidateResourcePath(relativePath: string): boolean {
  return [
    "worker",
    "python-runtime",
    "python-runtime-windows",
    "native",
    "model-manifest",
    "branding",
  ].some((root) => isWithin(relativePath, root));
}

function assertRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("../") ||
    path.posix.isAbsolute(relativePath) ||
    relativePath.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`Resource integrity rejected unsafe path: ${relativePath}`);
  }
}

function isAbsoluteLinkTarget(target: string): boolean {
  return path.isAbsolute(target) || path.win32.isAbsolute(target) || target.startsWith("\\\\");
}

function assertSafeSymlink(
  entry: ResourceTreeEntry,
  resourcesRealPath: string,
  includedRealPaths: ReadonlySet<string>,
): void {
  const target = entry.symlinkTarget;
  if (!target || Buffer.byteLength(target, "utf8") > MAX_SYMLINK_TARGET_BYTES || isAbsoluteLinkTarget(target)) {
    throw new Error(`Resource integrity rejected unsafe symlink: ${entry.relativePath}`);
  }
  let targetRealPath: string;
  try {
    targetRealPath = realpathSync(entry.absolutePath);
  } catch {
    throw new Error(`Resource integrity rejected broken symlink: ${entry.relativePath}`);
  }
  const relativeTarget = path.relative(resourcesRealPath, targetRealPath);
  if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget) || !includedRealPaths.has(targetRealPath)) {
    throw new Error(`Resource integrity rejected escaping symlink: ${entry.relativePath}`);
  }
}

function makeEntry(relativePath: string, absolutePath: string): ResourceTreeEntry {
  const stat = lstatSync(absolutePath);
  if (stat.isDirectory()) {
    return {
      relativePath,
      type: "directory",
      size: 0,
      contentHash: "",
      absolutePath,
    };
  }
  if (stat.isFile()) {
    return {
      relativePath,
      type: "file",
      size: stat.size,
      contentHash: hashFile(absolutePath, stat.size),
      absolutePath,
    };
  }
  if (stat.isSymbolicLink()) {
    const symlinkTarget = readlinkSync(absolutePath, "utf8");
    return {
      relativePath,
      type: "symlink",
      size: Buffer.byteLength(symlinkTarget, "utf8"),
      contentHash: sha256(Buffer.from(symlinkTarget, "utf8")),
      symlinkTarget,
      absolutePath,
    };
  }
  throw new Error(`Resource integrity rejected unsupported file type: ${relativePath}`);
}

function scanResourceTree(
  resourcesPath: string,
  platform: PackagedPlatform,
  arch: string,
  mode: ScanMode,
  sourceProjectPath?: string,
): ResourceTreeEntry[] {
  const descriptor = descriptorFor(platform, arch);
  const sourceUsesProjectLayout = mode === "source" && sourceProjectPath !== undefined;
  const resourceContainerPath = sourceUsesProjectLayout ? sourceProjectPath : resourcesPath;
  const resourcesRealPath = realpathSync(resourceContainerPath);
  const entries: ResourceTreeEntry[] = [];
  let totalFileBytes = 0;

  const absolutePathFor = (relativePath: string): string => {
    if (!sourceUsesProjectLayout) {
      return path.join(resourcesPath, ...relativePath.split("/"));
    }
    return isWithin(relativePath, "worker")
      ? path.join(sourceProjectPath, ...relativePath.split("/"))
      : path.join(sourceProjectPath, "resources", ...relativePath.split("/"));
  };

  const visit = (relativePath: string): void => {
    assertRelativePath(relativePath);
    const absolutePath = absolutePathFor(relativePath);
    const shouldInclude = isExpectedResourcePath(relativePath, descriptor);
    if (!shouldInclude) {
      if (mode === "packaged" && isCandidateResourcePath(relativePath)) {
        throw new Error(`Resource integrity found an unexpected loose resource: ${relativePath}`);
      }
      return;
    }
    const entry = makeEntry(relativePath, absolutePath);
    entries.push(entry);
    if (entries.length > MAX_RESOURCE_TREE_ENTRIES) {
      throw new Error(`Resource integrity rejected more than ${MAX_RESOURCE_TREE_ENTRIES} resource entries`);
    }
    if (entry.type === "file") {
      totalFileBytes += entry.size;
      if (totalFileBytes > MAX_RESOURCE_TREE_BYTES) {
        throw new Error(`Resource integrity rejected more than ${MAX_RESOURCE_TREE_BYTES} bytes of loose resources`);
      }
    }
    if (entry.type === "directory") {
      for (const child of readdirSync(absolutePath, { withFileTypes: true })
        .sort((left, right) => compareCanonical(left.name, right.name))) {
        visit(path.posix.join(relativePath, child.name));
      }
    }
  };

  for (const root of [
    "worker",
    "python-runtime",
    "python-runtime-windows",
    "native",
    "model-manifest",
    "branding",
  ]) {
    const candidate = absolutePathFor(root);
    if (existsSync(candidate)) visit(root);
  }

  const relativePaths = new Set(entries.map((entry) => entry.relativePath));
  for (const required of descriptor.coveredRoots) {
    if (!relativePaths.has(required)) {
      throw new Error(`Resource integrity is missing required loose resource: ${required}`);
    }
  }

  const includedRealPaths = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "symlink") includedRealPaths.add(realpathSync(entry.absolutePath));
  }
  for (const entry of entries) {
    if (entry.type === "symlink") assertSafeSymlink(entry, resourcesRealPath, includedRealPaths);
  }
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function treeRoot(
  entries: readonly ResourceTreeEntry[],
  descriptor: IntegrityDescriptor,
): string {
  const directoryEntries = new Set(entries.filter((entry) => entry.type === "directory").map((entry) => entry.relativePath));
  const entryHashes = new Map<string, string>();

  for (const entry of entries) {
    if (entry.type === "directory") continue;
    entryHashes.set(
      entry.relativePath,
      sha256([
        RESOURCE_INTEGRITY_DOMAIN,
        entry.type,
        entry.relativePath,
        String(entry.size),
        entry.symlinkTarget ?? "",
        entry.contentHash,
      ].join("\0")),
    );
  }

  const directoriesByDepth = [...directoryEntries].sort(
    (left, right) => right.split("/").length - left.split("/").length || compareCanonical(left, right),
  );
  for (const directory of directoriesByDepth) {
    const directChildren = [...entryHashes.entries()]
      .filter(([entryPath]) => path.posix.dirname(entryPath) === directory)
      .map(([entryPath, entryHash]) => [path.posix.basename(entryPath), entryHash] as const)
      .sort(([left], [right]) => compareCanonical(left, right));
    const directoryHash = sha256([
      RESOURCE_INTEGRITY_DOMAIN,
      "directory",
      directory,
      "0",
      ...directChildren.flatMap(([name, hash]) => [name, hash]),
    ].join("\0"));
    entryHashes.set(directory, directoryHash);
  }

  const rootChildren = [...entryHashes.entries()]
    .filter(([entryPath]) => path.posix.dirname(entryPath) === ".")
    .map(([entryPath, entryHash]) => [entryPath, entryHash] as const)
    .sort(([left], [right]) => compareCanonical(left, right));
  return sha256([
    RESOURCE_INTEGRITY_DOMAIN,
    "root",
    descriptor.platform,
    ...descriptor.coveredRoots,
    ...rootChildren.flatMap(([entryPath, entryHash]) => [entryPath, entryHash]),
  ].join("\0"));
}

function expectationFromTree(
  entries: readonly ResourceTreeEntry[],
  descriptor: IntegrityDescriptor,
): ResourceIntegrityExpectation {
  return {
    root: treeRoot(entries, descriptor),
    entryCount: entries.length,
    coveredRoots: descriptor.coveredRoots,
    platform: descriptor.platform,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function assertExpectationShape(
  expectation: ResourceIntegrityExpectation,
  descriptor: IntegrityDescriptor,
): void {
  if (
    !/^[a-f0-9]{64}$/.test(expectation.root) ||
    !Number.isSafeInteger(expectation.entryCount) ||
    expectation.entryCount <= 0 ||
    expectation.platform !== descriptor.platform ||
    !sameStrings(expectation.coveredRoots, descriptor.coveredRoots)
  ) {
    throw new Error("Resource integrity expectation embedded in app.asar is invalid for this platform");
  }
}

/** Derives the exact loose-resource tree that Forge will retain for one target. */
export function buildResourceIntegrityExpectation(
  resourcesPath: string,
  platform: PackagedPlatform,
  arch: string,
  sourceProjectPath?: string,
): ResourceIntegrityExpectation {
  const descriptor = descriptorFor(platform, arch);
  return expectationFromTree(
    scanResourceTree(resourcesPath, platform, arch, "source", sourceProjectPath),
    descriptor,
  );
}

/** Independently checks an already-pruned package tree against its ASAR-bundled expectation. */
export function assertPackagedResourceIntegrity(
  resourcesPath: string,
  platform: PackagedPlatform,
  arch: string,
  expectation: ResourceIntegrityExpectation,
): void {
  const descriptor = descriptorFor(platform, arch);
  assertExpectationShape(expectation, descriptor);
  const actual = expectationFromTree(scanResourceTree(resourcesPath, platform, arch, "packaged"), descriptor);
  if (actual.entryCount !== expectation.entryCount || actual.root !== expectation.root) {
    throw new Error(
      `Resource integrity mismatch for ${descriptor.platform}: expected ${expectation.root}/${expectation.entryCount}, received ${actual.root}/${actual.entryCount}`,
    );
  }
}

function renderGeneratedModule(expectation: ResourceIntegrityExpectation): string {
  return `export const generatedResourceIntegrity = ${JSON.stringify({
    root: expectation.root,
    entryCount: expectation.entryCount,
    coveredRoots: expectation.coveredRoots,
    platform: expectation.platform,
  }, null, 2)} as const;\n`;
}

/**
 * Writes the single generated module Vite imports into app.asar. It refuses to
 * overwrite a dirty/stale generated source and restores the committed
 * placeholder on package completion or normal process exit.
 */
export function prepareGeneratedResourceIntegrity(options: {
  resourcesPath: string;
  platform: PackagedPlatform;
  arch: string;
  generatedModulePath: string;
  /** Source trees keep worker/ next to resources/; packaged apps co-locate them. */
  sourceProjectPath?: string;
}): PreparedResourceIntegrity {
  if (activePreparation) throw new Error("A resource integrity package preparation is already active");
  const existing = readFileSync(options.generatedModulePath, "utf8");
  if (existing !== GENERATED_MODULE_PLACEHOLDER) {
    throw new Error(
      `Refusing to overwrite ${options.generatedModulePath}: restore the committed generated-resource placeholder first.`,
    );
  }
  const expectation = buildResourceIntegrityExpectation(
    options.resourcesPath,
    options.platform,
    options.arch,
    options.sourceProjectPath,
  );
  writeFileSync(options.generatedModulePath, renderGeneratedModule(expectation));

  let restored = false;
  const prepared: PreparedResourceIntegrity = {
    expectation,
    restore: () => {
      if (restored) return;
      writeFileSync(options.generatedModulePath, GENERATED_MODULE_PLACEHOLDER);
      restored = true;
      if (activePreparation === prepared) activePreparation = null;
    },
  };
  activePreparation = prepared;
  if (!restoreOnProcessExitInstalled) {
    restoreOnProcessExitInstalled = true;
    process.once("exit", () => {
      activePreparation?.restore();
    });
  }
  return prepared;
}

/**
 * Main-process startup gate. Development intentionally has no generated
 * expectation; packaged builds fail before model manifest parsing or worker
 * construction whenever a protected loose resource differs.
 */
export function verifyPackagedResourceIntegrity(
  options: ResourceIntegrityVerificationOptions,
): void {
  if (!options.isPackaged) return;
  const platform = packagedPlatformFor(options.platform ?? process.platform, options.arch ?? process.arch);
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  // The committed source is intentionally an invalid placeholder. Validate it
  // at runtime rather than weakening the generated module's literal type.
  const expectation = options.expected ?? (generatedResourceIntegrity as unknown as ResourceIntegrityExpectation);
  assertPackagedResourceIntegrity(resourcesPath, platform, options.arch ?? process.arch, expectation);
}

export const resourceIntegrityPlaceholderSource = GENERATED_MODULE_PLACEHOLDER;
