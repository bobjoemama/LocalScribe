import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

type ResourceInput = {
  readonly sourcePath: string;
  readonly stagedPath: string;
};

type ResourceSnapshot = ResourceInput & {
  readonly original: { readonly bytes: Buffer; readonly mode: number; readonly sha256: string } | null;
};

export type ProtectedResourcePreparation = {
  readonly restore: () => void;
};

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function ordinaryFile(filePath: string, label: string): { bytes: Buffer; mode: number } {
  const metadata = lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be an ordinary file: ${filePath}`);
  }
  return { bytes: readFileSync(filePath), mode: metadata.mode & 0o777 };
}

function originalFile(filePath: string): ResourceSnapshot["original"] {
  try {
    const source = ordinaryFile(filePath, "Protected source resource");
    return { ...source, sha256: digest(source.bytes) };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function replaceExact(filePath: string, bytes: Buffer, mode: number): void {
  const temporaryPath = `${filePath}.localscribe-stage.${process.pid}`;
  try {
    writeFileSync(temporaryPath, bytes, { flag: "wx", mode });
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, mode);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

/**
 * Atomically promotes ignored build outputs only for Forge's copy/sign phase,
 * then restores and verifies the tracked recovery inputs byte-for-byte.
 */
export function promoteProtectedResources(
  resources: readonly ResourceInput[],
): ProtectedResourcePreparation {
  if (resources.length === 0) throw new Error("No protected resources were supplied.");
  const sourcePaths = new Set<string>();
  const snapshots: ResourceSnapshot[] = resources.map((resource) => {
    if (sourcePaths.has(resource.sourcePath)) {
      throw new Error(`Duplicate protected source resource: ${resource.sourcePath}`);
    }
    sourcePaths.add(resource.sourcePath);
    ordinaryFile(resource.stagedPath, "Staged protected resource");
    return { ...resource, original: originalFile(resource.sourcePath) };
  });
  let active = true;
  const restore = (): void => {
    if (!active) return;
    const failures: string[] = [];
    for (const snapshot of snapshots) {
      try {
        if (snapshot.original) {
          replaceExact(snapshot.sourcePath, snapshot.original.bytes, snapshot.original.mode);
          const restored = ordinaryFile(snapshot.sourcePath, "Restored protected resource");
          if (
            restored.mode !== snapshot.original.mode ||
            digest(restored.bytes) !== snapshot.original.sha256
          ) {
            failures.push(`${snapshot.sourcePath} did not restore byte-for-byte`);
          }
        } else {
          ordinaryFile(snapshot.sourcePath, "Promoted protected resource");
          rmSync(snapshot.sourcePath);
        }
      } catch (error) {
        failures.push(`${snapshot.sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`Protected resource restoration failed: ${failures.join("; ")}`);
    }
    active = false;
  };
  try {
    for (const snapshot of snapshots) {
      const staged = ordinaryFile(snapshot.stagedPath, "Staged protected resource");
      replaceExact(snapshot.sourcePath, staged.bytes, staged.mode);
    }
  } catch (error) {
    restore();
    throw error;
  }
  return { restore };
}
