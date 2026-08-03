import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadRuntimeModelCatalog,
  loadRuntimePlatformModelCatalog,
  loadRuntimeModelSpec,
  modelManifestPath,
  modelSpecSchema,
  verifyModelDirectory,
  verifyRuntimeModelCatalog,
  verifyRuntimePlatformModelCatalog,
} from "../src/main/modelSpec";

const temporaryRoots: string[] = [];
const MAC_MANIFEST_FILENAMES = [
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

  it("loads default v3 and addable v2 pinned tiers for both packaged platforms", () => {
    const manifestDirectory = path.resolve("resources/model-manifest");
    const mac = loadRuntimeModelCatalog(manifestDirectory, "darwin", "arm64");
    const windows = loadRuntimeModelCatalog(manifestDirectory, "win32", "x64");
    const platformMac = loadRuntimePlatformModelCatalog(manifestDirectory, "darwin", "arm64");
    const platformWindows = loadRuntimePlatformModelCatalog(manifestDirectory, "win32", "x64");

    expect(platformMac.families["whisper-large-v3"]).toMatchObject({ familyId: mac.familyId });
    expect(platformWindows.families["whisper-large-v3"]).toMatchObject({ familyId: windows.familyId });
    expect(Object.keys(platformMac.families)).toEqual([
      "whisper-large-v3",
      "qwen3-asr-0-6b",
      "qwen3-asr-1-7b",
      "whisper-large-v2",
    ]);
    expect(Object.keys(platformWindows.families)).toEqual([
      "whisper-large-v3",
      "qwen3-asr-0-6b",
      "qwen3-asr-1-7b",
      "whisper-large-v2",
    ]);

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
    expect(windows).toMatchObject({
      platform: "win32-x64-cuda",
      engine: "faster-whisper",
      tiers: {
        high: { tier: "high", precision: "float16" },
        medium: { tier: "medium", precision: "int8_float16" },
        low: { tier: "low", precision: "int8" },
      },
    });

    expect(Object.values(mac.tiers).map((tier) => tier.engine)).toEqual([
      "mlx-whisper",
      "mlx-whisper",
      "mlx-whisper",
    ]);
    expect(Object.values(windows.tiers).map((tier) => tier.engine)).toEqual([
      "faster-whisper",
      "faster-whisper",
      "faster-whisper",
    ]);
    expect(new Set(Object.values(windows.tiers).map((tier) => tier.manifest.modelId))).toEqual(
      new Set(["Systran/faster-whisper-large-v3"]),
    );
    expect(windows.tiers.high.manifest).toEqual(windows.tiers.medium.manifest);
    expect(windows.tiers.medium.manifest).toEqual(windows.tiers.low.manifest);
    expect(new Set(Object.values(mac.tiers).map((tier) => tier.manifest.modelId)).size).toBe(3);
    expect(new Set(Object.values(mac.tiers).map((tier) => tier.manifest.storageDirectory)).size).toBe(3);

    const macV2 = platformMac.families["whisper-large-v2"];
    const windowsV2 = platformWindows.families["whisper-large-v2"];
    expect(macV2).toMatchObject({
      familyId: "whisper-large-v2",
      tiers: {
        high: { artifactId: "whisper-large-v2-mlx-fp16", profileId: "whisper-large-v2-high" },
        medium: { artifactId: "whisper-large-v2-mlx-int8", profileId: "whisper-large-v2-medium" },
        low: { artifactId: "whisper-large-v2-mlx-int4", profileId: "whisper-large-v2-low" },
      },
    });
    expect(macV2.tiers.high.manifest).toMatchObject({
      modelId: "mlx-community/whisper-large-v2-mlx",
      storageDirectory: "whisper-large-v2-mlx-cce8622",
      revision: "cce86229e2765266197fef869ce9f7e2550067ab",
      license: "Undeclared",
      files: {
        "config.json": { bytes: 268, sha256: "77d68bd8db0be90465fd7d35f8e4fa418297e449a27525060517a7e0df432c4b" },
        "weights.npz": { bytes: 3_083_149_424, sha256: "c9888a2d03b4e9906c2864151f56dc21e58d617938da0eb818152e3f99adc3f1" },
      },
    });
    expect(macV2.tiers.medium.manifest).toMatchObject({
      modelId: "mlx-community/whisper-large-v2-mlx-8bit",
      storageDirectory: "whisper-large-v2-mlx-8bit-ee1ab58",
      revision: "ee1ab587ec0827941f04d9bb0ff9c2005444ef80",
      license: "Undeclared",
    });
    expect(macV2.tiers.low.manifest).toMatchObject({
      modelId: "mlx-community/whisper-large-v2-mlx-4bit",
      storageDirectory: "whisper-large-v2-mlx-4bit-79e71f0",
      revision: "79e71f0c4946290e517db80c7a5cba6f91bdfcaf",
      license: "Undeclared",
    });
    expect(windowsV2).toMatchObject({
      familyId: "whisper-large-v2",
      tiers: {
        high: { artifactId: "whisper-large-v2-ctranslate2", profileId: "whisper-large-v2-high" },
        medium: { artifactId: "whisper-large-v2-ctranslate2", profileId: "whisper-large-v2-medium" },
        low: { artifactId: "whisper-large-v2-ctranslate2", profileId: "whisper-large-v2-low" },
      },
    });
    expect(windowsV2.tiers.high.manifest).toMatchObject({
      modelId: "Systran/faster-whisper-large-v2",
      storageDirectory: "faster-whisper-large-v2-f0fe815",
      revision: "f0fe81560cb8b68660e564f55dd99207059c092e",
      license: "MIT",
      files: {
        "config.json": { bytes: 2796, sha256: "d86b7a7664a12559d644aa210a32ce9a7e03913e794b7ea4fb7182de69e273a7" },
        "model.bin": { bytes: 3_086_912_962, sha256: "bf2a9746382e1aa7ffff6b3a0d137ed9edbd9670c3b87e5d35f5e85e70d0333a" },
        "tokenizer.json": { bytes: 2_203_239, sha256: "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab" },
        "vocabulary.txt": { bytes: 459_861, sha256: "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913" },
      },
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
    expect(platformWindows.families["qwen3-asr-1-7b"]).toMatchObject({
      displayName: "Qwen3-ASR 1.7B",
      engine: "crispasr",
      tiers: {
        high: { precision: "float16", artifactId: "qwen3-asr-1-7b-crisp-f16" },
        medium: { precision: "q8_0", artifactId: "qwen3-asr-1-7b-crisp-q8-0" },
        low: { precision: "q4_k", artifactId: "qwen3-asr-1-7b-crisp-q4-k" },
      },
    });
    expect(platformWindows.families["qwen3-asr-0-6b"]).toMatchObject({
      displayName: "Qwen3-ASR 0.6B",
      engine: "crispasr",
      tiers: {
        high: {
          precision: "float16",
          artifactId: "qwen3-asr-0-6b-crisp-f16",
          expectedDownloadBytes: 1_882_037_824,
        },
        medium: {
          precision: "q8_0",
          artifactId: "qwen3-asr-0-6b-crisp-q8-0",
          expectedDownloadBytes: 1_006_809_760,
        },
        low: {
          precision: "q4_k",
          artifactId: "qwen3-asr-0-6b-crisp-q4-k",
          expectedDownloadBytes: 631_026_336,
        },
      },
    });
    expect(windowsV2.tiers.high.manifest).toEqual(windowsV2.tiers.medium.manifest);
    expect(windowsV2.tiers.medium.manifest).toEqual(windowsV2.tiers.low.manifest);

    for (const catalog of [mac, windows]) {
      for (const tier of Object.values(catalog.tiers)) {
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

  it("keeps the legacy singleton loader on the medium tier", () => {
    const manifestDirectory = path.resolve("resources/model-manifest");
    expect(loadRuntimeModelSpec(manifestDirectory, "darwin", "arm64").modelId).toBe(
      "mlx-community/whisper-large-v3-mlx-8bit",
    );
    expect(loadRuntimeModelSpec(manifestDirectory, "win32", "x64").modelId).toBe(
      "Systran/faster-whisper-large-v3",
    );
    expect(modelManifestPath(manifestDirectory, "darwin", "arm64", "low")).toBe(
      path.join(manifestDirectory, "whisper-large-v3-mlx-4bit.json"),
    );
    expect(modelManifestPath(manifestDirectory, "darwin", "arm64", "low", "whisper-large-v2")).toBe(
      path.join(manifestDirectory, "whisper-large-v2-mlx-4bit.json"),
    );
  });

  it("verifies a shared Windows artifact once and projects it onto all compute tiers", async () => {
    const manifestDirectory = path.resolve("resources/model-manifest");
    const windows = loadRuntimeModelCatalog(manifestDirectory, "win32", "x64");
    const verification = {
      present: true,
      verified: true,
      verificationStatus: "verified" as const,
      sizeBytes: 3_090_835_702,
      expectedBytes: 3_090_835_702,
      verifiedFiles: 5,
      expectedFiles: 5,
    };
    const verifier = vi.fn(async () => verification);

    await expect(verifyRuntimeModelCatalog("/models", windows, verifier)).resolves.toEqual({
      high: verification,
      medium: verification,
      low: verification,
    });
    expect(verifier).toHaveBeenCalledOnce();
  });

  it("reports one verification per distinct family artifact across each platform", async () => {
    const manifestDirectory = path.resolve("resources/model-manifest");
    const mac = loadRuntimePlatformModelCatalog(manifestDirectory, "darwin", "arm64");
    const windows = loadRuntimePlatformModelCatalog(manifestDirectory, "win32", "x64");
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
    const windowsVerifier = vi.fn(async () => verification);

    await expect(
      verifyRuntimePlatformModelCatalog("/models", mac, macVerifier),
    ).resolves.toEqual([
      expect.objectContaining({ familyId: "whisper-large-v3", artifactId: "whisper-large-v3-mlx-fp16" }),
      expect.objectContaining({ familyId: "whisper-large-v3", artifactId: "whisper-large-v3-mlx-int8" }),
      expect.objectContaining({ familyId: "whisper-large-v3", artifactId: "whisper-large-v3-mlx-int4" }),
      expect.objectContaining({ familyId: "qwen3-asr-0-6b", artifactId: "qwen3-asr-0-6b-mlx-bf16" }),
      expect.objectContaining({ familyId: "qwen3-asr-0-6b", artifactId: "qwen3-asr-0-6b-mlx-8bit" }),
      expect.objectContaining({ familyId: "qwen3-asr-0-6b", artifactId: "qwen3-asr-0-6b-mlx-4bit" }),
      expect.objectContaining({ familyId: "qwen3-asr-1-7b", artifactId: "qwen3-asr-1-7b-mlx-bf16" }),
      expect.objectContaining({ familyId: "qwen3-asr-1-7b", artifactId: "qwen3-asr-1-7b-mlx-8bit" }),
      expect.objectContaining({ familyId: "qwen3-asr-1-7b", artifactId: "qwen3-asr-1-7b-mlx-4bit" }),
      expect.objectContaining({ familyId: "whisper-large-v2", artifactId: "whisper-large-v2-mlx-fp16" }),
      expect.objectContaining({ familyId: "whisper-large-v2", artifactId: "whisper-large-v2-mlx-int8" }),
      expect.objectContaining({ familyId: "whisper-large-v2", artifactId: "whisper-large-v2-mlx-int4" }),
    ]);
    expect(macVerifier).toHaveBeenCalledTimes(12);

    await expect(
      verifyRuntimePlatformModelCatalog("/models", windows, windowsVerifier),
    ).resolves.toEqual([
      expect.objectContaining({ familyId: "whisper-large-v3", artifactId: "whisper-large-v3-ctranslate2" }),
      expect.objectContaining({ familyId: "qwen3-asr-0-6b", artifactId: "qwen3-asr-0-6b-crisp-f16" }),
      expect.objectContaining({ familyId: "qwen3-asr-0-6b", artifactId: "qwen3-asr-0-6b-crisp-q8-0" }),
      expect.objectContaining({ familyId: "qwen3-asr-0-6b", artifactId: "qwen3-asr-0-6b-crisp-q4-k" }),
      expect.objectContaining({ familyId: "qwen3-asr-1-7b", artifactId: "qwen3-asr-1-7b-crisp-f16" }),
      expect.objectContaining({ familyId: "qwen3-asr-1-7b", artifactId: "qwen3-asr-1-7b-crisp-q8-0" }),
      expect.objectContaining({ familyId: "qwen3-asr-1-7b", artifactId: "qwen3-asr-1-7b-crisp-q4-k" }),
      expect.objectContaining({ familyId: "whisper-large-v2", artifactId: "whisper-large-v2-ctranslate2" }),
    ]);
    expect(windowsVerifier).toHaveBeenCalledTimes(8);
  });

  it("rejects cross-family storage aliasing before verification or removal can target it", async () => {
    const manifestDirectory = path.resolve("resources/model-manifest");
    const windows = loadRuntimePlatformModelCatalog(manifestDirectory, "win32", "x64");
    const sharedDirectory = windows.families["whisper-large-v3"].tiers.high.manifest.storageDirectory;
    const v2 = windows.families["whisper-large-v2"];
    const crossed = {
      ...windows,
      families: {
        ...windows.families,
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
    medium.backend = "faster-whisper/CTranslate2";
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

    const tier = loadRuntimeModelCatalog(
      root,
      "darwin",
      "arm64",
      "whisper-large-v2",
    ).tiers.low;
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
