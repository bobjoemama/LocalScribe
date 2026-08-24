import path from "node:path";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  assertSafeModelRoot,
  assertModelInstallIntentMatchesVerification,
  installVerifiedModelArtifact,
  modelArtifactDirectory,
  quarantineAndRemoveModelArtifact,
} from "../src/main/modelOperations";
import {
  loadRuntimeModelCatalog,
  runtimeModelTier,
  verifyModelDirectory,
  type ModelVerification,
} from "../src/main/modelSpec";

const model = runtimeModelTier(
  loadRuntimeModelCatalog(
    path.resolve("resources/model-manifest"),
    "darwin",
    "arm64",
  ),
  "medium",
).manifest;

function state(
  verificationStatus: "missing" | "invalid" | "verified",
): ModelVerification {
  return {
    present: verificationStatus !== "missing",
    verified: verificationStatus === "verified",
    verificationStatus,
    sizeBytes: 0,
    expectedBytes: 1,
    verifiedFiles: verificationStatus === "verified" ? 1 : 0,
    expectedFiles: 1,
  };
}

describe("main-process model operations", () => {
  it("fails closed when Download and Repair confirmations do not match disk state", () => {
    expect(() => assertModelInstallIntentMatchesVerification(false, state("missing")))
      .not.toThrow();
    expect(() => assertModelInstallIntentMatchesVerification(true, state("invalid")))
      .not.toThrow();
    expect(() => assertModelInstallIntentMatchesVerification(false, state("invalid")))
      .toThrow("confirm Repair");
    expect(() => assertModelInstallIntentMatchesVerification(true, state("missing")))
      .toThrow("confirm Download");
    expect(() => assertModelInstallIntentMatchesVerification(false, state("verified")))
      .toThrow("already verified");
    expect(() => assertModelInstallIntentMatchesVerification(true, state("verified")))
      .toThrow("already verified");
  });

  it("reports install success only after an independent post-install verification", async () => {
    const install = vi.fn(async () => undefined);
    const verify = vi.fn()
      .mockResolvedValueOnce(state("missing"))
      .mockResolvedValueOnce(state("verified"));

    await expect(installVerifiedModelArtifact({
      modelRoot: "/app-data/models",
      model,
      replaceExisting: false,
      install,
      verify,
    })).resolves.toMatchObject({ verificationStatus: "verified" });
    expect(install).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("does not start a download when the confirmed intent is stale", async () => {
    const install = vi.fn(async () => undefined);
    const verify = vi.fn(async () => state("invalid"));

    await expect(installVerifiedModelArtifact({
      modelRoot: "/app-data/models",
      model,
      replaceExisting: false,
      install,
      verify,
    })).rejects.toThrow("confirm Repair");
    expect(install).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledOnce();
  });

  it("rejects a worker acknowledgement when the resulting artifact is not verified", async () => {
    const install = vi.fn(async () => undefined);
    const verify = vi.fn()
      .mockResolvedValueOnce(state("missing"))
      .mockResolvedValueOnce(state("invalid"));

    await expect(installVerifiedModelArtifact({
      modelRoot: "/app-data/models",
      model,
      replaceExisting: false,
      install,
      verify,
    })).rejects.toThrow("main-process verification did not accept");
    expect(install).toHaveBeenCalledOnce();
  });

  it("keeps removals inside the app-owned model root", () => {
    expect(modelArtifactDirectory("/app-data/models", model)).toBe(
      path.resolve("/app-data/models", model.storageDirectory),
    );
    expect(() => modelArtifactDirectory("/app-data/models", {
      ...model,
      storageDirectory: "../outside",
    })).toThrow("escapes the app-owned model root");
  });

  it("rejects a symlinked model root without trusting or removing external data", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "localscribe-model-root-"));
    const external = await mkdtemp(path.join(os.tmpdir(), "localscribe-model-external-"));
    const linkedRoot = path.join(root, "models");
    const externalModel = path.join(external, model.storageDirectory);
    const sentinel = path.join(externalModel, "do-not-remove.txt");
    await mkdir(externalModel);
    await writeFile(sentinel, "external");
    await symlink(external, linkedRoot, "dir");
    const install = vi.fn(async () => undefined);

    try {
      await expect(verifyModelDirectory(linkedRoot, model)).resolves.toMatchObject({
        present: true,
        verified: false,
        verificationStatus: "invalid",
        sizeBytes: 0,
      });
      await expect(assertSafeModelRoot(linkedRoot, true)).rejects.toThrow(
        "must be a regular directory",
      );
      await expect(installVerifiedModelArtifact({
        modelRoot: linkedRoot,
        model,
        replaceExisting: true,
        install,
      })).rejects.toThrow("must be a regular directory");
      expect(install).not.toHaveBeenCalled();
      await expect(readFile(sentinel, "utf8")).resolves.toBe("external");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });

  it("treats a symlinked artifact as invalid without reading the external target", async () => {
    const modelRoot = await mkdtemp(path.join(os.tmpdir(), "localscribe-model-root-"));
    const external = await mkdtemp(path.join(os.tmpdir(), "localscribe-model-external-"));
    const externalSentinel = path.join(external, "weights.bin");
    await writeFile(externalSentinel, "external model data");
    await symlink(external, path.join(modelRoot, model.storageDirectory), "dir");

    try {
      await expect(verifyModelDirectory(modelRoot, model)).resolves.toMatchObject({
        present: true,
        verified: false,
        verificationStatus: "invalid",
        sizeBytes: 0,
        verifiedFiles: 0,
      });
      await expect(readFile(externalSentinel, "utf8")).resolves.toBe("external model data");
    } finally {
      await rm(modelRoot, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });

  it("atomically quarantines the exact artifact before recursive removal", async () => {
    const userData = await realpath(await mkdtemp(path.join(os.tmpdir(), "localscribe-user-data-")));
    const modelRoot = path.join(userData, "models");
    const artifact = path.join(modelRoot, model.storageDirectory);
    await mkdir(artifact, { recursive: true });
    await writeFile(path.join(artifact, "local-only.bin"), "local model");

    try {
      await expect(quarantineAndRemoveModelArtifact(modelRoot, model)).resolves.toBe("removed");
      await expect(readFile(path.join(artifact, "local-only.bin"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await readdir(userData)).some((name) =>
        name.startsWith(".localscribe-model-quarantine-"))).toBe(false);
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });

  it("fails closed when the artifact is swapped before its quarantine rename", async () => {
    const userData = await realpath(await mkdtemp(path.join(os.tmpdir(), "localscribe-user-data-")));
    const external = await mkdtemp(path.join(os.tmpdir(), "localscribe-external-model-"));
    const modelRoot = path.join(userData, "models");
    const artifact = path.join(modelRoot, model.storageDirectory);
    const displaced = path.join(modelRoot, `${model.storageDirectory}-displaced`);
    const sentinel = path.join(external, "do-not-remove.txt");
    await mkdir(artifact, { recursive: true });
    await writeFile(path.join(artifact, "local-only.bin"), "local model");
    await writeFile(sentinel, "external");

    try {
      await expect(quarantineAndRemoveModelArtifact(modelRoot, model, {
        beforeRename: async () => {
          await rename(artifact, displaced);
          await symlink(external, artifact, "dir");
        },
      })).rejects.toThrow("changed");
      await expect(readFile(sentinel, "utf8")).resolves.toBe("external");
      await expect(readFile(path.join(displaced, "local-only.bin"), "utf8"))
        .resolves.toBe("local model");
      expect((await readdir(userData)).some((name) =>
        name.startsWith(".localscribe-model-quarantine-"))).toBe(false);
    } finally {
      await rm(userData, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });
});
