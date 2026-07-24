import { listPackage } from "@electron/asar";
import { DestroyerOfModules } from "galactus";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  isForbiddenPackagedResourcePath,
  resourcePolicyFor,
  type PackagedPlatform,
} from "../src/shared/platformResourcePolicy";

export {
  resourcePolicyFor,
  type PackagedPlatform,
  type PlatformResourcePolicy,
} from "../src/shared/platformResourcePolicy";

type PackageManifest = {
  name?: string;
  productName?: string;
  version?: string;
  description?: string;
  main?: string;
  type?: string;
  author?: string | { name: string; email?: string; url?: string };
  license?: string;
  homepage?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const REQUIRED_NATIVE_RUNTIME_MODULES = ["better-sqlite3", "uiohook-napi"] as const;

function normalizeEntry(entry: string): string {
  return entry.replaceAll("\\", "/").replace(/^\/+/, "");
}

function readPackageManifest(packageJsonPath: string): PackageManifest {
  return JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageManifest;
}

function dependencyNames(manifest: PackageManifest): string[] {
  const requiredPeers = Object.keys(manifest.peerDependencies ?? {}).filter(
    (name) => !manifest.peerDependenciesMeta?.[name]?.optional,
  );
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...requiredPeers,
  ];
}

function requiredPeerDependencies(manifest: PackageManifest): Record<string, string> | undefined {
  const entries = Object.entries(manifest.peerDependencies ?? {}).filter(
    ([name]) => !manifest.peerDependenciesMeta?.[name]?.optional,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * The Vite plugin restores package.json after Packager's copy stage. Its
 * default manifest still declares every build-time dependency, which makes
 * Electron's later ASAR dependency walker look for packages we deliberately
 * removed. Keep only runtime resolution and release metadata before that
 * walker runs.
 */
export function sanitizeStagedPackageManifest(buildPath: string): void {
  const packageJsonPath = path.join(buildPath, "package.json");
  const manifest = readPackageManifest(packageJsonPath);
  const sanitized: PackageManifest = {};

  for (const field of [
    "name",
    "productName",
    "version",
    "description",
    "main",
    "type",
    "author",
    "license",
    "homepage",
  ] as const) {
    if (manifest[field] !== undefined) {
      // The union of the selected fields is intentionally copied unchanged.
      Object.assign(sanitized, { [field]: manifest[field] });
    }
  }
  if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) {
    sanitized.dependencies = manifest.dependencies;
  }
  if (manifest.optionalDependencies && Object.keys(manifest.optionalDependencies).length > 0) {
    sanitized.optionalDependencies = manifest.optionalDependencies;
  }
  const peers = requiredPeerDependencies(manifest);
  if (peers) sanitized.peerDependencies = peers;

  writeFileSync(packageJsonPath, `${JSON.stringify(sanitized, null, 2)}\n`);
}

function modulePath(nodeModulesPath: string, moduleName: string): string {
  return path.join(nodeModulesPath, ...moduleName.split("/"));
}

/**
 * Computes the production package closure from the package metadata available
 * to the release build. It deliberately starts from dependencies rather than
 * installed directories, so a stray build tool cannot become shippable merely
 * because it happens to be present in node_modules.
 */
export function productionDependencyClosure(projectPath: string): Set<string> {
  const rootManifest = readPackageManifest(path.join(projectPath, "package.json"));
  const nodeModulesPath = path.join(projectPath, "node_modules");
  const queue = [...dependencyNames(rootManifest)];
  const closure = new Set<string>();

  while (queue.length > 0) {
    const moduleName = queue.shift();
    if (!moduleName || closure.has(moduleName)) continue;
    closure.add(moduleName);

    const packageJsonPath = path.join(modulePath(nodeModulesPath, moduleName), "package.json");
    // An optional dependency can be legitimately absent for a target platform.
    if (!existsSync(packageJsonPath)) continue;
    queue.push(...dependencyNames(readPackageManifest(packageJsonPath)));
  }

  return closure;
}

function packageNamesInEntry(entry: string): string[] {
  const names: string[] = [];
  const matcher = /(?:^|\/)node_modules\/(?:(@[^/]+)\/([^/]+)|([^/@][^/]*))/g;
  for (const match of normalizeEntry(entry).matchAll(matcher)) {
    const scopedName = match[1] && match[2] ? `${match[1]}/${match[2]}` : match[3];
    if (scopedName) names.push(scopedName);
  }
  return names;
}

function walkEntries(directory: string, relativePath = ""): string[] {
  if (!existsSync(directory)) return [];
  const entries: string[] = [];
  for (const child of readdirSync(directory, { withFileTypes: true })) {
    const relativeChild = path.posix.join(relativePath, child.name);
    entries.push(relativeChild);
    if (child.isDirectory() && !child.isSymbolicLink()) {
      entries.push(...walkEntries(path.join(directory, child.name), relativeChild));
    }
  }
  return entries;
}

function removeEmptyDirectories(directory: string, preserveDirectory = false): boolean {
  if (!existsSync(directory)) return true;
  for (const child of readdirSync(directory, { withFileTypes: true })) {
    if (child.isDirectory() && !child.isSymbolicLink()) {
      removeEmptyDirectories(path.join(directory, child.name));
    }
  }
  const isEmpty = readdirSync(directory).length === 0;
  if (isEmpty && !preserveDirectory) rmdirSync(directory);
  return isEmpty;
}

function forbiddenPaths(entries: readonly string[]): string[] {
  return entries
    .map(normalizeEntry)
    .filter((entry) => isForbiddenPackagedResourcePath(entry))
    .sort();
}

function removeForbiddenArtifacts(directory: string): void {
  if (!existsSync(directory)) return;
  for (const child of readdirSync(directory, { withFileTypes: true })) {
    const childPath = path.join(directory, child.name);
    const normalized = normalizeEntry(child.name);
    if (isForbiddenPackagedResourcePath(normalized)) {
      rmSync(childPath, { recursive: true, force: true });
      continue;
    }
    if (child.isDirectory() && !child.isSymbolicLink()) {
      removeForbiddenArtifacts(childPath);
    }
  }
}

function retainOnly(directory: string, allowedRelativeFiles: ReadonlySet<string>): void {
  if (!existsSync(directory)) return;
  const keepParents = new Set<string>();
  for (const allowed of allowedRelativeFiles) {
    let current = normalizeEntry(allowed);
    while (current.includes("/")) {
      current = path.posix.dirname(current);
      keepParents.add(current);
    }
  }

  const visit = (currentDirectory: string, relative = ""): void => {
    for (const child of readdirSync(currentDirectory, { withFileTypes: true })) {
      const childRelative = normalizeEntry(path.posix.join(relative, child.name));
      const childPath = path.join(currentDirectory, child.name);
      if (child.isDirectory() && !child.isSymbolicLink()) {
        if (keepParents.has(childRelative)) {
          visit(childPath, childRelative);
        } else {
          rmSync(childPath, { recursive: true, force: true });
        }
      } else if (!allowedRelativeFiles.has(childRelative)) {
        rmSync(childPath, { force: true });
      }
    }
  };

  visit(directory);
  removeEmptyDirectories(directory, true);
}

function assertContainedSymlinks(resourcesPath: string): void {
  const resourcesRealPath = realpathSync(resourcesPath);
  for (const entry of walkEntries(resourcesPath)) {
    const candidate = path.join(resourcesPath, ...entry.split("/"));
    if (!lstatSync(candidate).isSymbolicLink()) continue;
    let target: string;
    try {
      target = realpathSync(candidate);
    } catch {
      throw new Error(`Packaged app inventory check failed: broken symlink ${entry}`);
    }
    const relativeTarget = path.relative(resourcesRealPath, target);
    if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
      throw new Error(`Packaged app inventory check failed: escaping symlink ${entry}`);
    }
  }
}

export function assertProductionPackageEntries(
  entries: readonly string[],
  allowedModules: ReadonlySet<string>,
): void {
  const normalizedEntries = entries.map(normalizeEntry);
  const forbiddenArtifacts = forbiddenPaths(normalizedEntries).concat(
    normalizedEntries.filter((entry) =>
      /(?:^|\/)node_modules\/(?:\.bin(?:\/|$)|\.package-lock\.json$)/.test(entry),
    ),
  );
  const unexpectedModules = [...new Set(normalizedEntries.flatMap(packageNamesInEntry))]
    .filter((name) => !allowedModules.has(name))
    .sort();

  const missingNativeModules = REQUIRED_NATIVE_RUNTIME_MODULES.filter(
    (name) => !normalizedEntries.some((entry) => packageNamesInEntry(entry).includes(name)),
  );

  if (forbiddenArtifacts.length > 0 || unexpectedModules.length > 0 || missingNativeModules.length > 0) {
    const problems = [
      forbiddenArtifacts.length > 0
        ? `development/source artifacts: ${[...new Set(forbiddenArtifacts)].sort().join(", ")}`
        : null,
      unexpectedModules.length > 0
        ? `modules outside the production dependency closure: ${unexpectedModules.join(", ")}`
        : null,
      missingNativeModules.length > 0
        ? `required native runtime modules missing: ${missingNativeModules.join(", ")}`
        : null,
    ].filter((problem): problem is string => problem !== null);
    throw new Error(`Packaged app inventory check failed: ${problems.join("; ")}`);
  }
}

export function assertPlatformResourceEntries(
  entries: readonly string[],
  platform: PackagedPlatform,
  arch: string,
): void {
  const policy = resourcePolicyFor(platform, arch);
  const normalizedEntries = entries.map(normalizeEntry);
  const fileEntries = new Set(normalizedEntries);
  const requiredFiles = [
    `${policy.workerDirectory}/__init__.py`,
    `${policy.workerDirectory}/__main__.py`,
    policy.runtimeExecutable,
    ...policy.helperFiles,
    ...policy.manifestFiles,
    ...policy.brandingFiles,
  ];
  const missingFiles = requiredFiles.filter((required) => !fileEntries.has(required));
  const forbidden = forbiddenPaths(normalizedEntries);

  const manifestEntries = normalizedEntries
    .filter((entry) => entry.startsWith("model-manifest/") && entry.endsWith(".json"))
    .sort();
  const expectedManifests = [...policy.manifestFiles].sort();
  if (JSON.stringify(manifestEntries) !== JSON.stringify(expectedManifests)) {
    forbidden.push(
      `model-manifest inventory expected [${expectedManifests.join(", ")}], received [${manifestEntries.join(", ")}]`,
    );
  }

  const oppositePlatformEntries = normalizedEntries.filter((entry) =>
    platform === "darwin"
      ? entry === "python-runtime-windows" ||
        entry.startsWith("python-runtime-windows/") ||
        entry.startsWith("worker/windows_transformers/") ||
        entry.startsWith("native/windows/") ||
        entry === "branding" ||
        entry.startsWith("branding/")
      : entry === "python-runtime" ||
        entry.startsWith("python-runtime/") ||
        entry.startsWith("worker/localscribe_worker/") ||
        entry.startsWith("native/macos/"),
  );
  forbidden.push(...oppositePlatformEntries);

  if (missingFiles.length > 0 || forbidden.length > 0) {
    const problems = [
      missingFiles.length > 0 ? `required platform files missing: ${missingFiles.join(", ")}` : null,
      forbidden.length > 0
        ? `forbidden or opposite-platform resources: ${[...new Set(forbidden)].sort().join(", ")}`
        : null,
    ].filter((problem): problem is string => problem !== null);
    throw new Error(`Packaged app resource inventory check failed: ${problems.join("; ")}`);
  }
}

/**
 * Runs after Forge has copied the Vite manifest into the staging app. Packager
 * already prunes while it copies, but Vite's custom filter means that behavior
 * must be verified and completed against the staged package.json as well.
 */
export async function pruneStagedNodeModules(buildPath: string): Promise<void> {
  const packageJsonPath = path.join(buildPath, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new Error(`Cannot prune packaged dependencies: missing ${packageJsonPath}`);
  }

  sanitizeStagedPackageManifest(buildPath);
  await new DestroyerOfModules({ rootDirectory: buildPath }).destroy();
  const nodeModulesPath = path.join(buildPath, "node_modules");
  for (const artifact of [".bin", ".vite", ".package-lock.json"]) {
    rmSync(path.join(nodeModulesPath, artifact), { recursive: true, force: true });
  }
  removeForbiddenArtifacts(nodeModulesPath);
  // Galactus removes package directories, but leaves their now-empty scope
  // parents behind. Removing them avoids ambiguous archive inventory entries.
  removeEmptyDirectories(nodeModulesPath, true);
}

/**
 * Extra resources are copied as whole source directories so their stable
 * runtime paths survive Electron Packager. Before signing, reduce those copies
 * to the platform allowlist and strip generated caches/tests.
 */
export function prunePackagedResources(
  resourcesPath: string,
  platform: PackagedPlatform,
  arch: string,
): void {
  const policy = resourcePolicyFor(platform, arch);

  const workerRelativeFiles = new Set(
    walkEntries(path.join(resourcesPath, policy.workerDirectory))
      .filter((entry) => !entry.endsWith("/"))
      .map((entry) =>
        path.posix.join(policy.workerDirectory.replace(/^worker\//, ""), entry),
      ),
  );
  retainOnly(path.join(resourcesPath, "worker"), workerRelativeFiles);
  removeForbiddenArtifacts(path.join(resourcesPath, "worker"));

  retainOnly(
    path.join(resourcesPath, "model-manifest"),
    new Set(policy.manifestFiles.map((entry) => entry.replace(/^model-manifest\//, ""))),
  );
  retainOnly(
    path.join(resourcesPath, "native"),
    new Set(policy.helperFiles.map((entry) => entry.replace(/^native\//, ""))),
  );
  if (policy.brandingFiles.length > 0) {
    retainOnly(
      path.join(resourcesPath, "branding"),
      new Set(policy.brandingFiles.map((entry) => entry.replace(/^branding\//, ""))),
    );
  } else {
    rmSync(path.join(resourcesPath, "branding"), { recursive: true, force: true });
  }

  const oppositeRuntime = platform === "darwin" ? "python-runtime-windows" : "python-runtime";
  rmSync(path.join(resourcesPath, oppositeRuntime), { recursive: true, force: true });
  removeForbiddenArtifacts(path.join(resourcesPath, policy.runtimeDirectory));
}

/**
 * The release gate checks app.asar, app.asar.unpacked, and every copied runtime
 * resource. Native modules live outside ASAR, so an archive-only scan would
 * provide a false sense of release integrity.
 */
export function assertPackagedAppInventory(
  resourcesPath: string,
  platform: PackagedPlatform,
  arch: string,
  projectPath = process.cwd(),
): void {
  const archivePath = path.join(resourcesPath, "app.asar");
  if (!existsSync(archivePath)) {
    throw new Error(`Packaged app inventory check failed: missing ${archivePath}`);
  }

  const archiveEntries = listPackage(archivePath, { isPack: false });
  const unpackedEntries = walkEntries(path.join(resourcesPath, "app.asar.unpacked"));
  assertProductionPackageEntries(
    [...archiveEntries, ...unpackedEntries],
    productionDependencyClosure(projectPath),
  );

  assertContainedSymlinks(resourcesPath);
  assertPlatformResourceEntries(walkEntries(resourcesPath), platform, arch);
}
