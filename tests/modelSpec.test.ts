import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultSettingsForRuntimeCatalog,
  loadRuntimeModelCatalog,
  loadRuntimePlatformModelCatalog,
  loadRuntimeModelSpec,
  manifestForWorkerSelection,
  MAX_MANIFEST_FILE_ENTRIES,
  modelManifestPath,
  modelSpecSchema,
  runtimeModelTier,
  supportedTiers,
  verifyModelDirectory,
  verifyRuntimePlatformModelCatalog,
} from "../src/main/modelSpec";

const temporaryRoots: string[] = [];
const MAC_MANIFEST_FILENAMES = [
  "canary-qwen-2-5b-gguf-bf16.json",
  "canary-qwen-2-5b-gguf-q8.json",
  "canary-qwen-2-5b-gguf-q4.json",
  "parakeet-unified-en-0-6b-coreml-fp16.json",
  "parakeet-unified-en-0-6b-coreml-int8.json",
  "whisper-large-v3-mlx.json",
  "whisper-large-v3-mlx-8bit.json",
  "whisper-large-v3-mlx-4bit.json",
  "qwen3-asr-0-6b-mlx-bf16.json",
  "qwen3-asr-0-6b-mlx-8bit.json",
  "qwen3-asr-0-6b-mlx-4bit.json",
  "qwen3-asr-1-7b-mlx-bf16.json",
  "qwen3-asr-1-7b-mlx-8bit.json",
  "qwen3-asr-1-7b-mlx-4bit.json",
  "whisper-large-v2-mlx.json",
  "whisper-large-v2-mlx-8bit.json",
  "whisper-large-v2-mlx-4bit.json",
] as const;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("packaged model specifications", () => {
  it("uses the same bounded manifest file ceiling as the standalone Python worker", () => {
    const worker = readFileSync("worker/localscribe_worker/worker.py", "utf8");
    const match = /MAX_MANIFEST_FILE_ENTRIES = (\d+)/u.exec(worker);
    expect(MAX_MANIFEST_FILE_ENTRIES).toBe(64);
    expect(Number(match?.[1])).toBe(MAX_MANIFEST_FILE_ENTRIES);
  });

  it("resolves worker manifests only for exact model, tier, compute, and declared mode", () => {
    const catalog = loadRuntimePlatformModelCatalog(
      path.resolve("resources/model-manifest"),
      "darwin",
      "arm64",
    );
    const parakeet = catalog.families["parakeet-unified-en-0-6b"]!;
    const medium = runtimeModelTier(parakeet, "medium");
    const exact = {
      modelId: medium.manifest.modelId,
      tier: medium.tier,
      computeType: "coreml-int8" as const,
      asrMode: "live" as const,
    };

    expect(manifestForWorkerSelection(catalog, exact)).toBe(medium.manifest);
    expect(manifestForWorkerSelection(catalog, { ...exact, computeType: "int8" })).toBeNull();
    expect(manifestForWorkerSelection(catalog, { ...exact, tier: "high" })).toBeNull();
    const whisper = runtimeModelTier(catalog.families["whisper-large-v3"]!, "high");
    expect(manifestForWorkerSelection(catalog, {
      modelId: whisper.manifest.modelId,
      tier: "high",
      computeType: "float16",
      asrMode: "live",
    })).toBeNull();
  });
  it("chooses the platform recommendation only for fresh runtime defaults", () => {
    const manifests = path.resolve("resources/model-manifest");
    const mac = defaultSettingsForRuntimeCatalog(
      loadRuntimePlatformModelCatalog(manifests, "darwin", "arm64"),
    );

    expect(mac).toMatchObject({
      activeModelFamilyId: "parakeet-unified-en-0-6b",
      modelLibraryFamilyIds: ["parakeet-unified-en-0-6b"],
      asrMode: "after-stop",
      modelPerformanceMode: "auto",
    });
  });

  it("accepts repository IDs but rejects manifest-supplied URLs and local paths", () => {
    const base = {
      schemaVersion: 1,
      familyId: "whisper-large-v3",
      artifactId: "test-artifact",
      platform: "darwin-arm64",
      backend: "MLX Whisper",
      displayName: "Test model",
      storageDirectory: "test-model",
      revision: "a".repeat(40),
      license: "MIT",
      files: {
        "weights.npz": { bytes: 1, sha256: "b".repeat(64) },
      },
    } as const;
    expect(modelSpecSchema.parse({
      ...base,
      modelId: "trusted-owner/trusted-model",
    }).modelId).toBe("trusted-owner/trusted-model");
    for (const modelId of [
      "https://untrusted.invalid/model",
      "file:///tmp/model",
      "../outside/model",
      "/absolute/model",
    ]) {
      expect(() => modelSpecSchema.parse({ ...base, modelId })).toThrow(
        /Hugging Face repository ID/,
      );
    }
  });

  it("loads the Mac-recommended Parakeet family while retaining pinned Whisper and Qwen families", () => {
    const manifestDirectory = path.resolve("resources/model-manifest");
    const mac = loadRuntimeModelCatalog(
      manifestDirectory,
      "darwin",
      "arm64",
      "whisper-large-v3",
    );
    const platformMac = loadRuntimePlatformModelCatalog(manifestDirectory, "darwin", "arm64");

    expect(platformMac.families["whisper-large-v3"]).toMatchObject({ familyId: mac.familyId });
    expect(Object.keys(platformMac.families)).toEqual([
      "parakeet-unified-en-0-6b",
      "whisper-large-v3",
      "qwen3-asr-0-6b",
      "qwen3-asr-1-7b",
      "canary-qwen-2-5b",
      "whisper-large-v2",
    ]);
    expect(platformMac.recommendedDefaultFamilyId).toBe("parakeet-unified-en-0-6b");
    expect(platformMac.families["parakeet-unified-en-0-6b"]).toMatchObject({
      engine: "fluid-audio",
      capabilities: { modes: ["after-stop", "live"], partialResults: true },
      tiers: {
        high: { precision: "coreml-fp16", artifactId: "parakeet-unified-en-0-6b-coreml-fp16" },
        medium: { precision: "coreml-int8", artifactId: "parakeet-unified-en-0-6b-coreml-int8" },
      },
    });
    expect(platformMac.families["parakeet-unified-en-0-6b"]?.tiers.low).toBeUndefined();

    expect(mac).toMatchObject({
      platform: "darwin-arm64",
      engine: "mlx-whisper",
      tiers: {
        high: {
          tier: "high",
          precision: "fp16",
          manifest: {
            modelId: "mlx-community/whisper-large-v3-mlx",
            revision: "49e6aa286ad60c14352c404340ded53710378a11",
          },
        },
        medium: {
          tier: "medium",
          precision: "8-bit",
          manifest: {
            modelId: "mlx-community/whisper-large-v3-mlx-8bit",
            revision: "04ca5b03c22d72ddf4f4b2d808a28bf9902fb71a",
            license: "Undeclared",
          },
        },
        low: {
          tier: "low",
          precision: "4-bit",
          manifest: {
            modelId: "mlx-community/whisper-large-v3-mlx-4bit",
            revision: "d12b5d0043a6fe0c59af321617fba041d4e8e0c8",
            license: "Undeclared",
          },
        },
      },
    });
    expect(supportedTiers(mac).map((name) => runtimeModelTier(mac, name).engine)).toEqual([
      "mlx-whisper",
      "mlx-whisper",
      "mlx-whisper",
    ]);
    expect(new Set(supportedTiers(mac).map((name) => runtimeModelTier(mac, name).manifest.modelId)).size).toBe(3);
    expect(new Set(supportedTiers(mac).map((name) => runtimeModelTier(mac, name).manifest.storageDirectory)).size).toBe(3);

    const macV2 = platformMac.families["whisper-large-v2"]!;
    expect(macV2).toMatchObject({
      familyId: "whisper-large-v2",
      tiers: {
        high: { artifactId: "whisper-large-v2-mlx-fp16", profileId: "whisper-large-v2-high" },
        medium: { artifactId: "whisper-large-v2-mlx-int8", profileId: "whisper-large-v2-medium" },
        low: { artifactId: "whisper-large-v2-mlx-int4", profileId: "whisper-large-v2-low" },
      },
    });
    expect(runtimeModelTier(macV2, "high").manifest).toMatchObject({
      modelId: "mlx-community/whisper-large-v2-mlx",
      storageDirectory: "whisper-large-v2-mlx-cce8622",
      revision: "cce86229e2765266197fef869ce9f7e2550067ab",
      license: "Undeclared",
      files: {
        "config.json": { bytes: 268, sha256: "77d68bd8db0be90465fd7d35f8e4fa418297e449a27525060517a7e0df432c4b" },
        "weights.npz": { bytes: 3_083_149_424, sha256: "c9888a2d03b4e9906c2864151f56dc21e58d617938da0eb818152e3f99adc3f1" },
      },
    });
    expect(runtimeModelTier(macV2, "medium").manifest).toMatchObject({
      modelId: "mlx-community/whisper-large-v2-mlx-8bit",
      storageDirectory: "whisper-large-v2-mlx-8bit-ee1ab58",
      revision: "ee1ab587ec0827941f04d9bb0ff9c2005444ef80",
      license: "Undeclared",
    });
    expect(runtimeModelTier(macV2, "low").manifest).toMatchObject({
      modelId: "mlx-community/whisper-large-v2-mlx-4bit",
      storageDirectory: "whisper-large-v2-mlx-4bit-79e71f0",
      revision: "79e71f0c4946290e517db80c7a5cba6f91bdfcaf",
      license: "Undeclared",
    });
    expect(platformMac.families["qwen3-asr-1-7b"]).toMatchObject({
      displayName: "Qwen3-ASR 1.7B",
      engine: "mlx-audio",
      tiers: {
        high: { precision: "bf16", artifactId: "qwen3-asr-1-7b-mlx-bf16" },
        medium: { precision: "8-bit", artifactId: "qwen3-asr-1-7b-mlx-8bit" },
        low: { precision: "4-bit", artifactId: "qwen3-asr-1-7b-mlx-4bit" },
      },
    });
    expect(platformMac.families["qwen3-asr-0-6b"]).toMatchObject({
      displayName: "Qwen3-ASR 0.6B",
      engine: "mlx-audio",
      tiers: {
        high: {
          precision: "bf16",
          artifactId: "qwen3-asr-0-6b-mlx-bf16",
          expectedDownloadBytes: 1_569_438_434,
        },
        medium: {
          precision: "8-bit",
          artifactId: "qwen3-asr-0-6b-mlx-8bit",
          expectedDownloadBytes: 1_010_773_761,
        },
        low: {
          precision: "4-bit",
          artifactId: "qwen3-asr-0-6b-mlx-4bit",
          expectedDownloadBytes: 712_781_279,
        },
      },
    });
    for (const catalog of Object.values(platformMac.families)) {
      for (const tierName of supportedTiers(catalog)) {
        const tier = runtimeModelTier(catalog, tierName);
        expect(tier.downloadEvidence.kind).toBe("measured");
        expect(tier.acceleratorMemory.evidence.kind).toBe("estimated");
        expect(tier.acceleratorMemory.maximumBytes).toBeGreaterThan(
          tier.acceleratorMemory.minimumBytes,
        );
        expect(
          Object.values(tier.manifest.files).reduce((sum, file) => sum + file.bytes, 0),
        ).toBe(tier.expectedDownloadBytes);
        for (const file of Object.values(tier.manifest.files)) {
          expect(file.bytes).toBeGreaterThan(0);
          expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
        }
      }
    }
  });

  it("keeps the legacy singleton loader on the recommended Parakeet medium tier", () => {
    const manifestDirectory = path.resolve("resources/model-manifest");
    expect(loadRuntimeModelSpec(manifestDirectory, "darwin", "arm64").modelId).toBe(
      "FluidInference/parakeet-unified-en-0.6b-coreml",
    );
    expect(() => modelManifestPath(manifestDirectory, "darwin", "arm64", "low")).toThrow(
      /no low profile/u,
    );
    expect(modelManifestPath(manifestDirectory, "darwin", "arm64", "low", "whisper-large-v3")).toBe(
      path.join(manifestDirectory, "whisper-large-v3-mlx-4bit.json"),
    );
    expect(modelManifestPath(manifestDirectory, "darwin", "arm64", "low", "whisper-large-v2")).toBe(
      path.join(manifestDirectory, "whisper-large-v2-mlx-4bit.json"),
    );
  });

  it("reports one verification per distinct Mac family artifact", async () => {
    const manifestDirectory = path.resolve("resources/model-manifest");
    const mac = loadRuntimePlatformModelCatalog(manifestDirectory, "darwin", "arm64");
    const verification = {
      present: false,
      verified: false,
      verificationStatus: "missing" as const,
      sizeBytes: 0,
      expectedBytes: 1,
      verifiedFiles: 0,
      expectedFiles: 1,
    };
    const macVerifier = vi.fn(async () => verification);

    await expect(
      verifyRuntimePlatformModelCatalog("/models", mac, macVerifier),
    ).resolves.toEqual([
      expect.objectContaining({ familyId: "parakeet-unified-en-0-6b", artifactId: "parakeet-unified-en-0-6b-coreml-fp16" }),
      expect.objectContaining({ familyId: "parakeet-unified-en-0-6b", artifactId: "parakeet-unified-en-0-6b-coreml-int8" }),
      expect.objectContaining({ familyId: "whisper-large-v3", artifactId: "whisper-large-v3-mlx-fp16" }),
      expect.objectContaining({ familyId: "whisper-large-v3", artifactId: "whisper-large-v3-mlx-int8" }),
      expect.objectContaining({ familyId: "whisper-large-v3", artifactId: "whisper-large-v3-mlx-int4" }),
      expect.objectContaining({ familyId: "qwen3-asr-0-6b", artifactId: "qwen3-asr-0-6b-mlx-bf16" }),
      expect.objectContaining({ familyId: "qwen3-asr-0-6b", artifactId: "qwen3-asr-0-6b-mlx-8bit" }),
      expect.objectContaining({ familyId: "qwen3-asr-0-6b", artifactId: "qwen3-asr-0-6b-mlx-4bit" }),
      expect.objectContaining({ familyId: "qwen3-asr-1-7b", artifactId: "qwen3-asr-1-7b-mlx-bf16" }),
      expect.objectContaining({ familyId: "qwen3-asr-1-7b", artifactId: "qwen3-asr-1-7b-mlx-8bit" }),
      expect.objectContaining({ familyId: "qwen3-asr-1-7b", artifactId: "qwen3-asr-1-7b-mlx-4bit" }),
      expect.objectContaining({ familyId: "canary-qwen-2-5b", artifactId: "canary-qwen-2-5b-gguf-bf16" }),
      expect.objectContaining({ familyId: "canary-qwen-2-5b", artifactId: "canary-qwen-2-5b-gguf-q8" }),
      expect.objectContaining({ familyId: "canary-qwen-2-5b", artifactId: "canary-qwen-2-5b-gguf-q4" }),
      expect.objectContaining({ familyId: "whisper-large-v2", artifactId: "whisper-large-v2-mlx-fp16" }),
      expect.objectContaining({ familyId: "whisper-large-v2", artifactId: "whisper-large-v2-mlx-int8" }),
      expect.objectContaining({ familyId: "whisper-large-v2", artifactId: "whisper-large-v2-mlx-int4" }),
    ]);
    expect(macVerifier).toHaveBeenCalledTimes(17);
  });

  it("rejects cross-family storage aliasing before verification or removal can target it", async () => {
    const manifestDirectory = path.resolve("resources/model-manifest");
    const mac = loadRuntimePlatformModelCatalog(manifestDirectory, "darwin", "arm64");
    const sharedDirectory = runtimeModelTier(mac.families["whisper-large-v3"]!, "high").manifest.storageDirectory;
    const v2 = mac.families["whisper-large-v2"]!;
    const crossed = {
      ...mac,
      families: {
        ...mac.families,
        "whisper-large-v2": {
          ...v2,
          tiers: Object.fromEntries(Object.entries(v2.tiers).map(([tier, spec]) => [
            tier,
            {
              ...spec,
              manifest: {
                ...spec.manifest,
                storageDirectory: sharedDirectory,
              },
            },
          ])) as typeof v2.tiers,
        },
      },
    };
    const verifier = vi.fn();

    await expect(
      verifyRuntimePlatformModelCatalog("/models", crossed, verifier),
    ).rejects.toThrow(/share a storage directory/);
    expect(verifier).not.toHaveBeenCalled();
  });

  it("rejects a cross-engine manifest even when its schema and platform are valid", async () => {
    const sourceDirectory = path.resolve("resources/model-manifest");
    const root = await mkdtemp(path.join(os.tmpdir(), "localscribe-model-catalog-"));
    temporaryRoots.push(root);

    for (const filename of MAC_MANIFEST_FILENAMES) {
      await writeFile(
        path.join(root, filename),
        await readFile(path.join(sourceDirectory, filename)),
      );
    }
    const mediumPath = path.join(root, "whisper-large-v3-mlx-8bit.json");
    const medium = JSON.parse(await readFile(mediumPath, "utf8")) as Record<string, unknown>;
    medium.backend = "FluidAudio CoreML / ANE";
    await writeFile(mediumPath, JSON.stringify(medium));

    expect(() => loadRuntimeModelCatalog(root, "darwin", "arm64")).toThrow(
      /medium model manifest backend mismatch/,
    );
  });

  it("derives immutable artifact identity from the curated packaged manifest", async () => {
    const sourceDirectory = path.resolve("resources/model-manifest");
    const root = await mkdtemp(path.join(os.tmpdir(), "localscribe-manifest-driven-"));
    temporaryRoots.push(root);
    for (const filename of MAC_MANIFEST_FILENAMES) {
      await writeFile(
        path.join(root, filename),
        await readFile(path.join(sourceDirectory, filename)),
      );
    }
    const lowPath = path.join(root, "whisper-large-v2-mlx-4bit.json");
    const low = JSON.parse(await readFile(lowPath, "utf8")) as Record<string, unknown>;
    low.modelId = "curated-owner/whisper-large-v2-custom";
    low.artifactId = "whisper-large-v2-mlx-int4-custom";
    low.storageDirectory = "whisper-large-v2-mlx-int4-custom";
    low.revision = "c".repeat(40);
    await writeFile(lowPath, JSON.stringify(low));

    const tier = runtimeModelTier(loadRuntimeModelCatalog(
      root,
      "darwin",
      "arm64",
      "whisper-large-v2",
    ), "low");
    expect(tier).toMatchObject({
      artifactId: "whisper-large-v2-mlx-int4-custom",
      expectedDownloadBytes: 973_192_389,
      manifest: {
        modelId: "curated-owner/whisper-large-v2-custom",
        storageDirectory: "whisper-large-v2-mlx-int4-custom",
        revision: "c".repeat(40),
      },
    });
    expect(tier.downloadEvidence.source).toContain(
      "curated-owner/whisper-large-v2-custom/tree/",
    );
  });

  it("marks same-size tampering present but not cryptographically verified", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "localscribe-model-spec-"));
    temporaryRoots.push(root);
    const model = modelSpecSchema.parse({
      schemaVersion: 1,
      familyId: "whisper-large-v2",
      artifactId: "test-model-artifact",
      platform: "darwin-arm64",
      backend: "test",
      displayName: "Test model",
      modelId: "example/test-model",
      storageDirectory: "test-model",
      revision: "a".repeat(40),
      license: "test",
      files: {
        "weights.bin": { bytes: 5, sha256: sha256("hello") },
      },
    });
    const directory = path.join(root, model.storageDirectory);
    await mkdir(directory);
    await writeFile(path.join(directory, "weights.bin"), "hello");

    await expect(verifyModelDirectory(root, model)).resolves.toMatchObject({
      present: true,
      verified: true,
      verificationStatus: "verified",
      sizeBytes: 5,
      expectedBytes: 5,
      verifiedFiles: 1,
      expectedFiles: 1,
    });

    await writeFile(path.join(directory, "unexpected.bin"), "x");
    await expect(verifyModelDirectory(root, model)).resolves.toMatchObject({
      present: true,
      verified: false,
      verificationStatus: "invalid",
      verifiedFiles: 1,
      expectedFiles: 1,
    });
    await rm(path.join(directory, "unexpected.bin"));

    await writeFile(path.join(directory, "weights.bin"), "world");
    await expect(verifyModelDirectory(root, model)).resolves.toMatchObject({
      present: true,
      verified: false,
      verificationStatus: "invalid",
      sizeBytes: 5,
      expectedBytes: 5,
      verifiedFiles: 0,
      expectedFiles: 1,
    });
  });
});
