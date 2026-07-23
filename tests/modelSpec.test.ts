import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadRuntimeModelCatalog,
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
  it("loads exactly three pinned tiers per platform without crossing engines", () => {
    const manifestDirectory = path.resolve("resources/model-manifest");
    const mac = loadRuntimeModelCatalog(manifestDirectory, "darwin", "arm64");
    const windows = loadRuntimeModelCatalog(manifestDirectory, "win32", "x64");

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
          },
        },
        low: {
          tier: "low",
          precision: "4-bit",
          manifest: {
            modelId: "mlx-community/whisper-large-v3-mlx-4bit",
            revision: "d12b5d0043a6fe0c59af321617fba041d4e8e0c8",
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
