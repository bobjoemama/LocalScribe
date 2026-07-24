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
} from "../src/main/modelSpec";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("packaged model specifications", () => {
  it("loads default v3 and addable v2 pinned tiers for both packaged platforms", () => {
    const manifestDirectory = path.resolve("resources/model-manifest");
    const mac = loadRuntimeModelCatalog(manifestDirectory, "darwin", "arm64");
    const windows = loadRuntimeModelCatalog(manifestDirectory, "win32", "x64");
    const platformMac = loadRuntimePlatformModelCatalog(manifestDirectory, "darwin", "arm64");
    const platformWindows = loadRuntimePlatformModelCatalog(manifestDirectory, "win32", "x64");

    expect(platformMac.families["whisper-large-v3"]).toMatchObject({ familyId: mac.familyId });
    expect(platformWindows.families["whisper-large-v3"]).toMatchObject({ familyId: windows.familyId });
    expect(Object.keys(platformMac.families)).toEqual(["whisper-large-v3", "whisper-large-v2"]);
    expect(Object.keys(platformWindows.families)).toEqual(["whisper-large-v3", "whisper-large-v2"]);

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

  it("rejects a cross-engine manifest even when its schema and platform are valid", async () => {
    const sourceDirectory = path.resolve("resources/model-manifest");
    const root = await mkdtemp(path.join(os.tmpdir(), "localscribe-model-catalog-"));
    temporaryRoots.push(root);

    for (const filename of [
      "whisper-large-v3-mlx.json",
      "whisper-large-v3-mlx-8bit.json",
      "whisper-large-v3-mlx-4bit.json",
      "whisper-large-v2-mlx.json",
      "whisper-large-v2-mlx-8bit.json",
      "whisper-large-v2-mlx-4bit.json",
    ]) {
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
