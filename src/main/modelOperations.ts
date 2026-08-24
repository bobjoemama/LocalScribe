import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import {
  inspectModelRootDirectory,
  verifyModelDirectory,
  type ModelSpec,
  type ModelVerification,
} from "./modelSpec";

type ModelVerifier = (modelRoot: string, model: ModelSpec) => Promise<ModelVerification>;

interface RemovalIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
}

export interface ModelRemovalTestHooks {
  /** Deterministic race seam; production callers must omit it. */
  beforeRename?(): Promise<void>;
}

function removalIdentity(metadata: Awaited<ReturnType<typeof lstat>>): RemovalIdentity {
  return {
    device: BigInt(metadata.dev),
    inode: BigInt(metadata.ino),
    mode: BigInt(metadata.mode),
  };
}

function sameRemovalIdentity(
  left: RemovalIdentity,
  right: RemovalIdentity,
): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode;
}

async function noFollowDirectoryIdentity(directory: string): Promise<RemovalIdentity> {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("The local model removal path changed or is not a regular directory.");
  }
  return removalIdentity(metadata);
}

/**
 * Binds the renderer's separately confirmed Download/Repair action to current
 * disk state. This prevents a stale or forged Download request from replacing
 * invalid data without repair confirmation, and prevents a stale Repair from
 * silently changing into a first-time download.
 */
export function assertModelInstallIntentMatchesVerification(
  replaceExisting: boolean,
  verification: ModelVerification,
): void {
  if (verification.verificationStatus === "verified") {
    throw new Error(
      "This local speech model is already verified. Refresh model status before trying again.",
    );
  }
  if (verification.verificationStatus === "invalid" && !replaceExisting) {
    throw new Error(
      "Existing local model data is invalid. Refresh model status and confirm Repair before replacing it.",
    );
  }
  if (verification.verificationStatus === "missing" && replaceExisting) {
    throw new Error(
      "There is no local model data to repair. Refresh model status and confirm Download instead.",
    );
  }
}

/**
 * Runs the explicit install/repair transaction and independently verifies the
 * result in main before the renderer may report success.
 */
export async function installVerifiedModelArtifact(input: {
  modelRoot: string;
  model: ModelSpec;
  replaceExisting: boolean;
  install(): Promise<void>;
  verify?: ModelVerifier;
}): Promise<ModelVerification> {
  const verify = input.verify ?? verifyModelDirectory;
  await assertSafeModelRoot(input.modelRoot, true);
  const before = await verify(input.modelRoot, input.model);
  assertModelInstallIntentMatchesVerification(input.replaceExisting, before);
  await input.install();
  const installed = await verify(input.modelRoot, input.model);
  if (!installed.verified) {
    throw new Error(
      "The local speech model worker completed, but main-process verification did not accept the installed artifact.",
    );
  }
  return installed;
}

/** Rejects roots that main and the Python worker would interpret differently. */
export async function assertSafeModelRoot(
  modelRoot: string,
  allowMissing = false,
): Promise<"safe" | "missing"> {
  const status = await inspectModelRootDirectory(modelRoot);
  if (status === "safe" || (allowMissing && status === "missing")) return status;
  if (status === "missing") {
    throw new Error("The app-owned local model storage directory is missing.");
  }
  throw new Error(
    "The app-owned local model storage path is unsafe. It must be a regular directory, not a symlink or file.",
  );
}

/** Resolves a manifest-owned storage directory and rejects any root escape. */
export function modelArtifactDirectory(modelRoot: string, model: ModelSpec): string {
  const resolvedRoot = path.resolve(modelRoot);
  const target = path.resolve(resolvedRoot, model.storageDirectory);
  if (target === resolvedRoot || !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("The curated model storage directory escapes the app-owned model root.");
  }
  return target;
}

/**
 * Atomically detach one manifest-owned artifact before recursively deleting it.
 *
 * The random quarantine is a newly-created sibling of `models` under the
 * already-resolved userData directory. Root/source identities are checked on
 * both sides of the rename; recursive deletion starts only after the moved
 * directory has the exact source inode. If a same-UID process wins any checked
 * race, the operation fails closed and preserves the quarantined directory.
 * A same-UID attacker can still race after the final check because Node has no
 * portable directory-fd-relative recursive deletion API; the unpredictable
 * private quarantine makes that residual materially narrower.
 */
export async function quarantineAndRemoveModelArtifact(
  modelRoot: string,
  model: ModelSpec,
  hooks: ModelRemovalTestHooks = {},
): Promise<"missing" | "removed"> {
  const rootStatus = await assertSafeModelRoot(modelRoot, true);
  if (rootStatus === "missing") return "missing";
  const resolvedRoot = path.resolve(modelRoot);
  const trustedParent = path.dirname(resolvedRoot);
  if (await realpath(trustedParent) !== trustedParent || await realpath(resolvedRoot) !== resolvedRoot) {
    throw new Error("The local model storage path changed before removal.");
  }
  const parentIdentity = await noFollowDirectoryIdentity(trustedParent);
  const rootIdentity = await noFollowDirectoryIdentity(resolvedRoot);
  const source = modelArtifactDirectory(resolvedRoot, model);
  let sourceIdentity: RemovalIdentity;
  try {
    sourceIdentity = await noFollowDirectoryIdentity(source);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    throw error;
  }

  const quarantine = path.join(
    trustedParent,
    `.localscribe-model-quarantine-${randomUUID()}`,
  );
  await mkdir(quarantine, { mode: 0o700 });
  const quarantineIdentity = await noFollowDirectoryIdentity(quarantine);
  const quarantinedArtifact = path.join(quarantine, model.storageDirectory);
  let moved = false;
  try {
    await hooks.beforeRename?.();
    const identitiesStillMatch = sameRemovalIdentity(
      parentIdentity,
      await noFollowDirectoryIdentity(trustedParent),
    ) && sameRemovalIdentity(
      rootIdentity,
      await noFollowDirectoryIdentity(resolvedRoot),
    ) && sameRemovalIdentity(
      sourceIdentity,
      await noFollowDirectoryIdentity(source),
    ) && sameRemovalIdentity(
      quarantineIdentity,
      await noFollowDirectoryIdentity(quarantine),
    );
    if (!identitiesStillMatch) {
      throw new Error("The local model removal path changed before quarantine.");
    }

    await rename(source, quarantinedArtifact);
    moved = true;
    if (
      !sameRemovalIdentity(sourceIdentity, await noFollowDirectoryIdentity(quarantinedArtifact))
      || !sameRemovalIdentity(quarantineIdentity, await noFollowDirectoryIdentity(quarantine))
      || !sameRemovalIdentity(rootIdentity, await noFollowDirectoryIdentity(resolvedRoot))
    ) {
      throw new Error("The local model artifact changed during quarantine.");
    }
    await rm(quarantinedArtifact, { recursive: true, force: false });
    await rmdir(quarantine);
    return "removed";
  } catch (error) {
    // An empty quarantine is safe to retire. Once the source has moved, retain
    // it on any mismatch or deletion error rather than risking unrelated data.
    if (!moved) {
      try {
        await rmdir(quarantine);
      } catch {
        // Preserve unexpected contents for inspection.
      }
    }
    throw error;
  }
}
