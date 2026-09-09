import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertModelSelectionSupported,
  loadRuntimePlatformModelCatalog,
  manifestForWorkerSelection,
  runtimeModelTier,
  supportedTiers,
  workerComputeTypeForTier,
} from "../src/main/modelSpec";
import { buildModelCatalogSnapshot } from "../src/main/modelCatalogSnapshot";
import { workerLanguageForModel } from "../src/shared/modelLanguage";
import { modelFamilyPresentation, supportedModeChoices } from "../src/renderer/settings/screens/ModelPerformanceSettings";

const catalog = loadRuntimePlatformModelCatalog(path.resolve("resources/model-manifest"), "darwin", "arm64");
const family = catalog.families["canary-qwen-2-5b"]!;

describe("Canary integration contracts", () => {
  it("keeps the recommended default and offers three distinct precision profiles", () => {
    expect(catalog.recommendedDefaultFamilyId).toBe("parakeet-unified-en-0-6b");
    expect(supportedTiers(family)).toEqual(["high", "medium", "low"]);
    const tiers = supportedTiers(family).map((tier) => runtimeModelTier(family, tier));
    expect(tiers.map((tier) => tier.precision)).toEqual(["bf16", "8-bit", "4-bit"]);
    expect(tiers.map((tier) => tier.expectedDownloadBytes)).toEqual([5076107136, 2797548928, 1737575808]);
    expect(new Set(tiers.map((tier) => tier.manifest.storageDirectory)).size).toBe(3);
    for (const tier of tiers) {
      expect(tier.engine).toBe("transcribe-cpp");
      expect(tier.manifest.license).toBe("CC-BY-4.0");
      expect(tier.manifest.revision).toBe("3370d4e2f28cc70eea79dfc9f2f43fb91eef3163");
      expect(tier.acceleratorMemory.evidence.kind).toBe("estimated");
    }
  });

  it.each(["auto", "high", "medium", "low"] as const)("rejects Live even with %s precision", (preference) => {
    expect(() => assertModelSelectionSupported(catalog, {
      familyId: family.familyId, asrMode: "live", preference,
    })).toThrow(/does not support live/u);
    expect(assertModelSelectionSupported(catalog, {
      familyId: family.familyId, asrMode: "after-stop", preference,
    })).toBe(family);
  });

  it("maps all three selections to their exact manifests without profile fallback", () => {
    for (const tier of supportedTiers(family)) {
      const profile = runtimeModelTier(family, tier);
      expect(manifestForWorkerSelection(catalog, {
        modelId: profile.manifest.modelId, tier,
        computeType: workerComputeTypeForTier(profile), asrMode: "after-stop",
      })).toBe(profile.manifest);
    }
  });

  it("is English-only and exposes no prompts or live capability", () => {
    expect(family.capabilities).toEqual({
      modes: ["after-stop"], partialResults: false, timestamps: false,
      languageDetection: false, promptContext: false, keywordBoost: false,
      supportedLanguages: ["en"],
    });
    expect(workerLanguageForModel("Auto", family.capabilities, family.displayName)).toBe("en");
    expect(() => workerLanguageForModel("Spanish", family.capabilities, family.displayName)).toThrow(/does not support/u);
  });

  it("presents the real catalog as after-stop only, not multilingual Qwen", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "localscribe-canary-catalog-"));
    try {
      const snapshot = await buildModelCatalogSnapshot({
        catalog, modelRoot: root,
        settings: { activeModelFamilyId: "parakeet-unified-en-0-6b", modelLibraryFamilyIds: [] },
      });
      const entry = snapshot.families.find((item) => item.familyId === family.familyId)!;
      const presentation = modelFamilyPresentation(entry);
      expect(presentation.experiences).toEqual(["after-stop"]);
      expect(presentation.languageLabel).toBe("English");
      expect(presentation.summary).not.toContain("multilingual");
      expect(supportedModeChoices(entry).map((choice) => choice.id)).toEqual(["auto", "high", "medium", "low"]);
      expect(snapshot.families.filter((item) => modelFamilyPresentation(item).experiences.includes("live")))
        .not.toContain(entry);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
