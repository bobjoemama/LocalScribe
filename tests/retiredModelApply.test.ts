import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { appSettingsSchema, DEFAULT_SETTINGS, type AppSettings, type ModelSelectionApplyResult } from "../src/shared/contracts";
import { modelSelectionIsAvailable } from "../src/shared/modelAvailability";
import { assertModelSelectionSupported, loadRuntimePlatformModelCatalog, resolveModelPerformance, workerComputeTypeForTier, type RuntimeModelTierSpec } from "../src/main/modelSpec";

// Execute the actual main-process Apply function, with I/O boundaries replaced
// by fakes. This catches an unconditional resolution of the retired selection
// before the supported replacement gets a chance to load.
const source = ts.createSourceFile("main.ts", readFileSync("src/main.ts", "utf8"), ts.ScriptTarget.Latest, true);
const functions = source.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && ["savedModelSelectionIsAvailable", "applyModelSelection"].includes(node.name?.text ?? ""));
const executable = ts.transpileModule(functions.map((node) => node.getText(source)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const catalog = loadRuntimePlatformModelCatalog(path.resolve("resources/model-manifest"), "darwin", "arm64");
const memory = { totalBytes: 48 * 1024 ** 3, freeBytes: 32 * 1024 ** 3 };

function harness(saved: AppSettings, verified = true, failLoad = false) {
  let current = saved;
  const save = vi.fn((settings: AppSettings) => (current = settings));
  const shutdown = vi.fn(async () => undefined);
  const ensureReady = vi.fn(async () => { if (failLoad) throw new Error("fixture load failed"); });
  const resolveOldSelection = vi.fn(() => { throw new Error("Retired selection must not be resolved"); });
  const context = {
    Error,
    modelSelectionIsAvailable,
    runExclusiveModelOperation: (operation: () => unknown) => operation(),
    assertModelSwitchAllowed: () => undefined,
    assertModelSelectionSupported,
    platformModelCatalog: () => catalog,
    assertFamilyInLibrary: () => undefined,
    database: { getSettings: () => current, saveSettings: save },
    assertModelLanguageSupported: () => undefined,
    currentModelResolution: resolveOldSelection,
    worker: { loadedSelection: () => null, shutdown, ensureReady },
    modelResolution: null,
    resolveSelection: resolveOldSelection,
    previousAutoTier: undefined,
    acceleratorSnapshot: {},
    appSettingsSchema,
    memorySnapshot: () => memory,
    resolveModelPerformance,
    assertResolutionFitsMemory: (resolution: { fitsMemoryBudget: boolean }) => {
      if (!resolution.fitsMemoryBudget) throw new Error("Insufficient memory");
    },
    app: { getPath: () => "/fixture" },
    modelRootForUserData: () => "/fixture/models",
    verifyModelDirectory: vi.fn(async () => ({ verified, present: false, verificationStatus: verified ? "verified" : "missing" })),
    probeUnloadedAccelerator: vi.fn(async () => undefined),
    workerSelection: (tier: RuntimeModelTierSpec, asrMode: string) => ({ modelId: tier.manifest.modelId, tier: tier.tier, computeType: workerComputeTypeForTier(tier), asrMode }),
    collectModelCatalogForSettings: vi.fn(async () => ({})),
    collectDiagnosticsForResolution: vi.fn(async () => ({})),
    notifySettingsChanged: vi.fn(),
    quitting: false,
  };
  const apply = vm.runInNewContext(`${executable}\napplyModelSelection;`, context) as
    (request: { familyId: string; asrMode: string; performanceMode: string }) => Promise<ModelSelectionApplyResult>;
  return { apply: () => apply({ familyId: "parakeet-unified-en-0-6b", asrMode: "after-stop", performanceMode: "medium" }),
    getSettings: () => current, save, shutdown, ensureReady, resolveOldSelection };
}

describe("Apply recovery from retired saved selections", () => {
  const settings = (family: AppSettings["activeModelFamilyId"], mode: AppSettings["modelPerformanceMode"]) => appSettingsSchema.parse({
    ...DEFAULT_SETTINGS, activeModelFamilyId: family, modelPerformanceMode: mode, language: "en",
    modelLibraryFamilyIds: [family, "parakeet-unified-en-0-6b"],
  });

  it.each([ ["whisper-large-v2", "auto"], ["whisper-large-v3", "low"] ] as const)(
    "loads only the explicit replacement for %s/%s and persists after load", async (family, mode) => {
      const fixture = harness(settings(family, mode));
      const result = await fixture.apply();
      expect(result.appliedSelection).toMatchObject({ familyId: "parakeet-unified-en-0-6b", tier: "medium" });
      expect(fixture.resolveOldSelection).not.toHaveBeenCalled();
      expect(fixture.ensureReady).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ modelId: "FluidInference/parakeet-unified-en-0.6b-coreml", computeType: "coreml-int8" }));
      expect(fixture.save.mock.invocationCallOrder[0]).toBeGreaterThan(fixture.ensureReady.mock.invocationCallOrder[0]!);
      expect(fixture.getSettings().activeModelFamilyId).toBe("parakeet-unified-en-0-6b");
    },
  );

  it("keeps the retired settings and performs no unload when replacement verification fails", async () => {
    const saved = settings("whisper-large-v2", "medium");
    const fixture = harness(saved, false);
    await expect(fixture.apply()).rejects.toThrow(/not cryptographically verified/);
    expect(fixture.shutdown).not.toHaveBeenCalled();
    expect(fixture.ensureReady).not.toHaveBeenCalled();
    expect(fixture.save).not.toHaveBeenCalled();
    expect(fixture.getSettings()).toBe(saved);
  });

  it("keeps saved settings and terminates the failed replacement without loading another model", async () => {
    const saved = settings("whisper-large-v3", "low");
    const fixture = harness(saved, true, true);
    await expect(fixture.apply()).rejects.toThrow(/fixture load failed/);
    expect(fixture.shutdown).toHaveBeenCalledTimes(2);
    expect(fixture.ensureReady).toHaveBeenCalledTimes(1);
    expect(fixture.save).not.toHaveBeenCalled();
    expect(fixture.getSettings()).toBe(saved);
  });
});
