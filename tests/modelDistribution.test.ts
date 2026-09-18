import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertDistributableModelLicenses } from "../scripts/model-license-policy";
import { assertPlatformResourceEntries } from "../scripts/package-inventory";
import { resourcePolicyFor } from "../src/shared/platformResourcePolicy";
import { assertModelSelectionSupported, loadRuntimePlatformModelCatalog, manifestForWorkerSelection } from "../src/main/modelSpec";
import { buildModelCatalogSnapshot } from "../src/main/modelCatalogSnapshot";
import { unavailableModelDiagnostics } from "../src/main/unavailableModelDiagnostics";
import { appSettingsSchema, DEFAULT_SETTINGS, diagnosticsSchema, type ModelFamilyId, type ModelPerformanceMode } from "../src/shared/contracts";
import { modelSelectionIsAvailable } from "../src/shared/modelAvailability";

const catalog = loadRuntimePlatformModelCatalog(path.resolve("resources/model-manifest"), "darwin", "arm64");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "localscribe-distribution-"));
  roots.push(root);
  return root;
}

describe("license-reviewed distributable model catalog", () => {
  it("ships exactly eleven profiles across four families, with no Whisper runtime", () => {
    expect(Object.keys(catalog.families)).toEqual([
      "parakeet-unified-en-0-6b", "qwen3-asr-0-6b", "qwen3-asr-1-7b", "canary-qwen-2-5b",
    ]);
    expect(catalog.families["whisper-large-v3"]).toBeUndefined();
    expect(catalog.families["whisper-large-v2"]).toBeUndefined();
    expect(resourcePolicyFor("darwin", "arm64").manifestFiles).toHaveLength(11);
    expect(() => assertDistributableModelLicenses(process.cwd())).not.toThrow();
  });

  it("refuses an undeclared license in any manifest that would actually ship", () => {
    const root = temporaryRoot();
    cpSync("resources/model-manifest", path.join(root, "resources/model-manifest"), { recursive: true });
    const file = path.join(root, "resources/model-manifest/qwen3-asr-0-6b-mlx-bf16.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    manifest.license = "Undeclared";
    writeFileSync(file, JSON.stringify(manifest));
    expect(() => assertDistributableModelLicenses(root)).toThrow(/Unreviewed model license/);
  });

  it.each([
    ["whisper-large-v2", "high", "mlx-community/whisper-large-v2-mlx", "float16"],
    ["whisper-large-v2", "medium", "mlx-community/whisper-large-v2-mlx-8bit", "int8"],
    ["whisper-large-v2", "low", "mlx-community/whisper-large-v2-mlx-4bit", "int4"],
    ["whisper-large-v3", "high", "mlx-community/whisper-large-v3-mlx", "float16"],
    ["whisper-large-v3", "medium", "mlx-community/whisper-large-v3-mlx-8bit", "int8"],
    ["whisper-large-v3", "low", "mlx-community/whisper-large-v3-mlx-4bit", "int4"],
  ] as const)("preserves but refuses retired %s/%s without fallback", (familyId, tier, modelId, computeType) => {
    const saved = appSettingsSchema.parse({ ...DEFAULT_SETTINGS, activeModelFamilyId: familyId, modelLibraryFamilyIds: [familyId], modelPerformanceMode: tier });
    expect(saved.activeModelFamilyId).toBe(familyId);
    expect(saved.modelPerformanceMode).toBe(tier);
    const family = catalog.families[familyId];
    expect(modelSelectionIsAvailable({ familyId, asrMode: "after-stop", performanceMode: tier },
      family ? { modes: family.capabilities.modes, tiers: Object.keys(family.tiers) } : undefined)).toBe(false);
    expect(manifestForWorkerSelection(catalog, { modelId, tier, computeType })).toBeNull();
  });

  it.each(["whisper-large-v2", "whisper-large-v3"] as const)("refuses retired %s Auto without choosing a replacement", (familyId) => {
    expect(() => assertModelSelectionSupported(catalog, {
      familyId, asrMode: "after-stop", preference: "auto",
    })).toThrow(/unavailable|not available|unsupported/u);
  });

  it("rejects excluded manifests injected into an otherwise complete package", () => {
    const policy = resourcePolicyFor("darwin", "arm64");
    const entries = [`${policy.workerDirectory}/__init__.py`, `${policy.workerDirectory}/__main__.py`,
      policy.runtimeExecutable, ...policy.helperFiles, ...policy.manifestFiles, ...policy.licenseFiles, ...policy.legalFiles];
    expect(() => assertPlatformResourceEntries(entries, "darwin", "arm64")).not.toThrow();
    for (const name of ["whisper-large-v2-mlx.json", "whisper-large-v2-mlx-8bit.json", "whisper-large-v2-mlx-4bit.json",
      "whisper-large-v3-mlx.json", "whisper-large-v3-mlx-8bit.json", "whisper-large-v3-mlx-4bit.json"]) {
      expect(() => assertPlatformResourceEntries([...entries, `model-manifest/${name}`], "darwin", "arm64"))
        .toThrow(/model-manifest inventory/);
    }
  });

  it.each(["whisper-large-v2", "whisper-large-v3"] as const)("reports retired %s cached files as unmanaged without deleting them or changing settings", async (familyId) => {
    const root = temporaryRoot();
    const directory = `${familyId}-mlx-cce8622`;
    mkdirSync(path.join(root, directory));
    const file = path.join(root, directory, "weights.npz");
    writeFileSync(file, "preserve existing model data");
    const settings = { activeModelFamilyId: familyId, modelLibraryFamilyIds: [familyId] };
    const before = JSON.stringify(settings);
    const snapshot = await buildModelCatalogSnapshot({ settings, catalog, modelRoot: root });
    expect(snapshot.activeModelFamilyId).toBe(familyId);
    expect(snapshot.families.some((family) => family.familyId.startsWith("whisper-"))).toBe(false);
    expect(snapshot.unmanagedEntries).toContainEqual(expect.objectContaining({ name: directory, reason: "unmanaged" }));
    expect(readFileSync(file, "utf8")).toBe("preserve existing model data");
    expect(JSON.stringify(settings)).toBe(before);
  });

  it.each<[ModelFamilyId, ModelPerformanceMode]>([["whisper-large-v2", "auto"], ["whisper-large-v3", "auto"], ["whisper-large-v3", "high"], ["whisper-large-v3", "medium"]])(
    "keeps diagnostics usable for %s/%s without inventing a model", (activeModelFamilyId, modelPerformanceMode) => {
      const result = unavailableModelDiagnostics({ activeModelFamilyId, modelPerformanceMode }, {
        platform: "darwin", architecture: "arm64", databaseIntegrity: "ok", unreadableRecords: 0, dataPath: "/test",
        accelerator: { kind: "apple-unified", displayName: "Apple Silicon", totalMemoryBytes: 48 * 1024 ** 3,
          freeMemoryBytes: 32 * 1024 ** 3, memoryBasis: "measured" },
      });
      expect(() => diagnosticsSchema.parse(result)).not.toThrow();
      expect(result.performance.resolvedTier).toBeNull();
      expect(result.performance.resolutionReason).toContain("Apply model");
      expect(result.model.familyId).toBe(activeModelFamilyId);
      expect(() => diagnosticsSchema.parse({ ...result, model: { ...result.model, loaded: true } })).toThrow();
    },
  );
});
