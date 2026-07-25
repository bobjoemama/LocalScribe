import path from "node:path";
import {
  inspectModelRootDirectory,
  verifyModelDirectory,
  type ModelSpec,
  type ModelVerification,
} from "./modelSpec";

type ModelVerifier = (modelRoot: string, model: ModelSpec) => Promise<ModelVerification>;

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
