import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildModelCatalogSnapshot,
  modelRootForUserData,
} from "../src/main/modelCatalogSnapshot";
import { loadRuntimePlatformModelCatalog } from "../src/main/modelSpec";
import { modelCatalogSchema, RETIRED_MODEL_FAMILY_IDS } from "../src/shared/contracts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("main-process model catalog snapshot", () => {
  it.each(RETIRED_MODEL_FAMILY_IDS)("carries retired %s through the actual renderer contract without substitution", async (retired) => {
    const modelRoot = await mkdtemp(path.join(os.tmpdir(), "localscribe-retired-snapshot-"));
    temporaryRoots.push(modelRoot);
    const catalog = loadRuntimePlatformModelCatalog(path.resolve("resources/model-manifest"), "darwin", "arm64");
    const settings = { activeModelFamilyId: retired, modelLibraryFamilyIds: [retired] };
    const before = modelCatalogSchema.parse(await buildModelCatalogSnapshot({ settings, catalog, modelRoot }));
    expect(before.activeModelFamilyId).toBe(retired);
    expect(before.modelLibraryFamilyIds).toEqual([retired]);
    expect(before.families.every((family) => !family.active)).toBe(true);
    expect(before.families.some((family) => family.familyId === retired)).toBe(false);

    // An explicit replacement may preserve the legacy library entry. Its real
    // snapshot must still pass the same schema used by preload/Apply results.
    const after = modelCatalogSchema.parse(await buildModelCatalogSnapshot({
      settings: {
        activeModelFamilyId: "parakeet-unified-en-0-6b",
        modelLibraryFamilyIds: [retired, "parakeet-unified-en-0-6b"],
      }, catalog, modelRoot,
    }));
    expect(after.activeModelFamilyId).toBe("parakeet-unified-en-0-6b");
    expect(after.modelLibraryFamilyIds).toContain(retired);

    const missingCurrent = {
      ...after,
      families: after.families.filter((family) => family.familyId !== "parakeet-unified-en-0-6b"),
    };
    expect(() => modelCatalogSchema.parse(missingCurrent)).toThrow(/unavailable|recommendation/);
    expect(() => modelCatalogSchema.parse({
      ...before,
      families: [...before.families, { ...before.families[0], familyId: retired, active: true, inLibrary: true, recommendedDefault: false }],
    })).toThrow(/Retired families cannot expose runnable profiles/);
  });

  it("reports all supported Mac artifacts and exposes the platform recommendation", async () => {
    const modelRoot = await mkdtemp(path.join(os.tmpdir(), "localscribe-model-snapshot-"));
    temporaryRoots.push(modelRoot);
    const catalog = loadRuntimePlatformModelCatalog(
      path.resolve("resources/model-manifest"),
      "darwin",
      "arm64",
    );

    const snapshot = await buildModelCatalogSnapshot({
      settings: {
        activeModelFamilyId: "qwen3-asr-0-6b",
        modelLibraryFamilyIds: ["qwen3-asr-0-6b"],
      },
      catalog,
      modelRoot,
    });

    expect(() => modelCatalogSchema.parse(snapshot)).not.toThrow();
    expect(snapshot.recommendedDefaultFamilyId).toBe("parakeet-unified-en-0-6b");
    expect(snapshot.verifications).toHaveLength(11);
    expect(snapshot.verifications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        familyId: "parakeet-unified-en-0-6b",
        artifactId: "parakeet-unified-en-0-6b-coreml-fp16",
        verificationStatus: "missing",
      }),
      expect.objectContaining({
        familyId: "parakeet-unified-en-0-6b",
        artifactId: "parakeet-unified-en-0-6b-coreml-int8",
        verificationStatus: "missing",
      }),
      expect.objectContaining({
        familyId: "qwen3-asr-0-6b",
        artifactId: "qwen3-asr-0-6b-mlx-bf16",
        verificationStatus: "missing",
      }),
      expect.objectContaining({
        familyId: "qwen3-asr-0-6b",
        artifactId: "qwen3-asr-0-6b-mlx-8bit",
        verificationStatus: "missing",
      }),
      expect.objectContaining({
        familyId: "qwen3-asr-1-7b",
        artifactId: "qwen3-asr-1-7b-mlx-8bit",
        verificationStatus: "missing",
      }),
    ]));
    expect(snapshot.families.find((family) => family.familyId === "whisper-large-v2"))
      .toBeUndefined();
    expect(snapshot.families.find((family) => family.familyId === "parakeet-unified-en-0-6b"))
      .toMatchObject({ recommendedDefault: true, capabilities: { modes: ["after-stop", "live"] } });
    expect(snapshot.unmanagedEntries).toEqual([]);
  });

  it("keeps the model root under app-owned userData", () => {
    expect(modelRootForUserData("/private/app-data")).toBe(
      path.join("/private/app-data", "models"),
    );
  });

  it("reports unmanaged and interrupted model data without following symlinks", async () => {
    const modelRoot = await mkdtemp(path.join(os.tmpdir(), "localscribe-model-snapshot-"));
    const external = await mkdtemp(path.join(os.tmpdir(), "localscribe-model-external-"));
    temporaryRoots.push(modelRoot, external);
    await mkdir(path.join(modelRoot, "qwen3-asr-old"));
    await writeFile(path.join(modelRoot, "qwen3-asr-old", "weights.bin"), "12345");
    await mkdir(path.join(modelRoot, ".whisper-medium-staging-deadbeef"));
    await writeFile(path.join(modelRoot, ".whisper-medium-staging-deadbeef", "partial.bin"), "123");
    await mkdir(path.join(modelRoot, ".localscribe-model-install-aabbccddeeff00112233445566778899"));
    await writeFile(
      path.join(
        modelRoot,
        ".localscribe-model-install-aabbccddeeff00112233445566778899",
        "transaction.json",
      ),
      "{}",
    );
    await writeFile(path.join(external, "sentinel.bin"), "do not count this");
    await symlink(external, path.join(modelRoot, "external-link"), "dir");
    const catalog = loadRuntimePlatformModelCatalog(
      path.resolve("resources/model-manifest"),
      "darwin",
      "arm64",
    );

    const snapshot = await buildModelCatalogSnapshot({
      settings: {
        activeModelFamilyId: "qwen3-asr-0-6b",
        modelLibraryFamilyIds: ["qwen3-asr-0-6b"],
      },
      catalog,
      modelRoot,
    });

    expect(snapshot.unmanagedEntries).toEqual(expect.arrayContaining([
      {
        name: "qwen3-asr-old",
        kind: "directory",
        reason: "unmanaged",
        sizeBytes: 5,
      },
      {
        name: ".whisper-medium-staging-deadbeef",
        kind: "directory",
        reason: "interrupted-install",
        sizeBytes: 3,
      },
      {
        name: ".localscribe-model-install-aabbccddeeff00112233445566778899",
        kind: "directory",
        reason: "interrupted-install",
        sizeBytes: 2,
      },
      {
        name: "external-link",
        kind: "symlink",
        reason: "unmanaged",
        sizeBytes: null,
      },
    ]));
  });

});
