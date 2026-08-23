import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertModelSelectionSupported,
  loadRuntimePlatformModelCatalog,
  modelSpecSchema,
  runtimeModelTier,
  verifyModelDirectory,
} from "../src/main/modelSpec";
import { modelCatalogSchema } from "../src/shared/contracts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("curated Parakeet Unified catalog", () => {
  it("reports the actual multilingual Whisper language and prompt capabilities", () => {
    const catalog = loadRuntimePlatformModelCatalog(
      path.resolve("resources/model-manifest"),
      "darwin",
      "arm64",
    );
    const whisper = catalog.families["whisper-large-v3"];
    expect(whisper?.capabilities).toMatchObject({
      modes: ["after-stop"],
      languageDetection: true,
      promptContext: true,
      supportedLanguages: ["auto", "en", "es", "fr", "de", "hi"],
    });
  });

  it("recommends an Apple-native, two-mode family on macOS without faking a Low profile", () => {
    const catalog = loadRuntimePlatformModelCatalog(
      path.resolve("resources/model-manifest"),
      "darwin",
      "arm64",
    );
    const parakeet = catalog.families["parakeet-unified-en-0-6b"];
    expect(catalog.recommendedDefaultFamilyId).toBe("parakeet-unified-en-0-6b");
    expect(parakeet).toMatchObject({
      displayName: "Parakeet Unified EN 0.6B",
      engine: "fluid-audio",
      capabilities: {
        modes: ["after-stop", "live"],
        partialResults: true,
        supportedLanguages: ["en"],
      },
      tiers: {
        high: { precision: "coreml-fp16", artifactId: "parakeet-unified-en-0-6b-coreml-fp16" },
        medium: { precision: "coreml-int8", artifactId: "parakeet-unified-en-0-6b-coreml-int8" },
      },
    });
    expect(parakeet?.tiers.low).toBeUndefined();
    expect(parakeet).toBeDefined();
    expect(runtimeModelTier(parakeet!, "high").manifest.files).toHaveProperty(
      "parakeet_unified_encoder.mlmodelc/weights/weight.bin",
    );
  });

  it("fails closed for unsupported live and absent explicit profiles", () => {
    const catalog = loadRuntimePlatformModelCatalog(
      path.resolve("resources/model-manifest"),
      "darwin",
      "arm64",
    );
    expect(() => assertModelSelectionSupported(catalog, {
      familyId: "parakeet-unified-en-0-6b",
      asrMode: "live",
      preference: "medium",
    })).not.toThrow();
    expect(() => assertModelSelectionSupported(catalog, {
      familyId: "qwen3-asr-0-6b",
      asrMode: "live",
      preference: "high",
    })).toThrow(/does not support live/u);
    expect(() => assertModelSelectionSupported(catalog, {
      familyId: "parakeet-unified-en-0-6b",
      asrMode: "after-stop",
      preference: "low",
    })).toThrow(/no low performance profile/u);
  });

  it("rejects a snapshot that references a Mac library family omitted from its catalog", () => {
    const invalid = {
      platform: "darwin-arm64",
      activeModelFamilyId: "parakeet-unified-en-0-6b",
      modelLibraryFamilyIds: ["parakeet-unified-en-0-6b", "whisper-large-v3"],
      recommendedDefaultFamilyId: "parakeet-unified-en-0-6b",
      families: [{
        familyId: "parakeet-unified-en-0-6b",
        displayName: "Parakeet Unified EN 0.6B",
        capabilities: {
          modes: ["after-stop", "live"], partialResults: true, timestamps: false,
          languageDetection: false, promptContext: false, keywordBoost: false,
          supportedLanguages: ["en"],
        },
        recommendedDefault: true,
        active: true,
        inLibrary: true,
        artifacts: [{
          artifactId: "parakeet-unified-en-0-6b-coreml-fp16", displayName: "Parakeet", backend: "FluidAudio CoreML / ANE",
          modelId: "trusted-owner/parakeet", storageDirectory: "parakeet", revision: "a".repeat(40),
          license: "MIT", expectedDownloadBytes: 1,
        }],
        profiles: [{
          profileId: "parakeet-unified-en-0-6b-high", tier: "high", artifactId: "parakeet-unified-en-0-6b-coreml-fp16",
          engine: "fluid-audio", precision: "coreml-fp16", expectedMemoryMinBytes: 1,
          expectedMemoryMaxBytes: 2, memoryBasis: "estimated",
        }],
      }],
      verifications: [{
        familyId: "parakeet-unified-en-0-6b", artifactId: "parakeet-unified-en-0-6b-coreml-fp16", present: false, verified: false,
        verificationStatus: "missing", sizeBytes: 0, expectedBytes: 1, verifiedFiles: 0, expectedFiles: 1,
      }],
      unmanagedEntries: [],
    };
    expect(() => modelCatalogSchema.parse(invalid)).toThrow(/unavailable on this platform/u);
  });
});

describe("nested CoreML manifest boundaries", () => {
  const nestedSpec = modelSpecSchema.parse({
    schemaVersion: 1,
    platform: "darwin-arm64",
    backend: "FluidAudio CoreML / ANE",
    displayName: "Nested test model",
    modelId: "trusted-owner/trusted-model",
    familyId: "parakeet-unified-en-0-6b",
    artifactId: "nested-test-model",
    storageDirectory: "nested-test-model",
    revision: "a".repeat(40),
    license: "MIT",
    files: {
      "bundle.mlmodelc/metadata.json": { bytes: 2, sha256: digest("{}") },
      "bundle.mlmodelc/weights/weight.bin": { bytes: 2, sha256: digest("ok") },
    },
  });

  async function install(): Promise<{ root: string; model: string }> {
    const root = await mkdtemp(path.join(os.tmpdir(), "localscribe-nested-model-"));
    temporaryRoots.push(root);
    const model = path.join(root, nestedSpec.storageDirectory);
    await mkdir(path.join(model, "bundle.mlmodelc", "weights"), { recursive: true });
    await writeFile(path.join(model, "bundle.mlmodelc", "metadata.json"), "{}");
    await writeFile(path.join(model, "bundle.mlmodelc", "weights", "weight.bin"), "ok");
    return { root, model };
  }

  it("accepts safe normalized nested paths and verifies the complete tree", async () => {
    const { root } = await install();
    await expect(verifyModelDirectory(root, nestedSpec)).resolves.toMatchObject({ verified: true });
  });

  it("rejects traversal, backslash, and empty nested segments at the manifest boundary", () => {
    for (const name of ["../weights.bin", "bundle/../weights.bin", "bundle//weights.bin", "bundle\\weights.bin", "/weights.bin"]) {
      expect(() => modelSpecSchema.parse({ ...nestedSpec, files: {
        [name]: { bytes: 1, sha256: digest("x") },
      } })).toThrow();
    }
  });

  it("bounds nested-path depth, length, and manifest entry count", () => {
    const tooDeep = Array.from({ length: 17 }, () => "bundle").join("/");
    const tooLong = `${"a".repeat(1_021)}.bin`;
    expect(() => modelSpecSchema.parse({ ...nestedSpec, files: {
      [`${tooDeep}/weight.bin`]: { bytes: 1, sha256: digest("x") },
    } })).toThrow(/depth/u);
    expect(() => modelSpecSchema.parse({ ...nestedSpec, files: {
      [tooLong]: { bytes: 1, sha256: digest("x") },
    } })).toThrow();
    const files = Object.fromEntries(Array.from({ length: 513 }, (_, index) => [
      `bundle-${index}.bin`,
      { bytes: 1, sha256: digest(String(index)) },
    ]));
    expect(() => modelSpecSchema.parse({ ...nestedSpec, files })).toThrow(/at most 512/u);
  });

  it("rejects an injected nested file and a nested symlink", async () => {
    const extra = await install();
    await writeFile(path.join(extra.model, "bundle.mlmodelc", "payload.bin"), "x");
    await expect(verifyModelDirectory(extra.root, nestedSpec)).resolves.toMatchObject({ verified: false });

    const linked = await install();
    const target = path.join(linked.root, "outside.bin");
    await writeFile(target, "ok");
    const linkedWeight = path.join(linked.model, "bundle.mlmodelc", "weights", "weight.bin");
    await rm(linkedWeight);
    await symlink(target, linkedWeight);
    await expect(verifyModelDirectory(linked.root, nestedSpec)).resolves.toMatchObject({ verified: false });
  });
});
