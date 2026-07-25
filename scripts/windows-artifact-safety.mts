import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";

const FRESHNESS_TOLERANCE_MS = 2_000;

function assertContained(childPath: string, parentPath: string, label: string): void {
  const relative = path.relative(parentPath, childPath);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.length === 0) {
    throw new Error(`${label} is not a strict child of ${parentPath}: ${childPath}`);
  }
}

function assertDirectoryWithoutReparsePoints(directory: string, allowedRoot: string): void {
  const root = path.resolve(allowedRoot);
  const resolved = path.resolve(directory);
  assertContained(resolved, root, "Windows maker output");
  if (existsSync(root)) {
    const rootMetadata = lstatSync(root);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      throw new Error(`Windows maker output root is not an ordinary directory: ${root}`);
    }
  }
  let current = root;
  for (const segment of path.relative(root, resolved).split(path.sep)) {
    current = path.join(current, segment);
    if (!existsSync(current)) continue;
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Windows maker output parent is not an ordinary directory: ${current}`);
    }
  }
}

/**
 * Removes only the exact Forge maker target after proving that neither it nor
 * an existing parent is a link/reparse target. This prevents an older
 * same-version artifact from satisfying a failed maker invocation.
 */
export function clearWindowsMakerOutput(
  projectPath: string,
  relativeTarget: string,
): void {
  const project = realpathSync(path.resolve(projectPath));
  const outRoot = path.join(project, "out");
  const target = path.resolve(project, relativeTarget);
  assertContained(target, outRoot, "Windows maker target");
  assertDirectoryWithoutReparsePoints(target, outRoot);
  if (existsSync(target)) rmSync(target, { recursive: true, force: false });
  mkdirSync(path.dirname(target), { recursive: true });
}

export function assertFreshOrdinaryArtifact(
  filePath: string,
  buildStartedAtMs: number,
): void {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    throw new Error(`Windows maker artifact is missing: ${resolved}`);
  }
  const metadata = lstatSync(resolved);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size === 0) {
    throw new Error(`Windows maker artifact must be a non-empty ordinary file: ${resolved}`);
  }
  if (
    !Number.isFinite(buildStartedAtMs) ||
    buildStartedAtMs <= 0 ||
    metadata.mtimeMs + FRESHNESS_TOLERANCE_MS < buildStartedAtMs
  ) {
    throw new Error(
      `Windows maker artifact predates this make invocation: ${resolved}`,
    );
  }
}
