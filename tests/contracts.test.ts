import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  HISTORY_RETENTION_OPTIONS,
  MODEL_FAMILY_IDS,
  MODEL_PERFORMANCE_MODES,
  appSettingsPatchSchema,
  appSettingsSchema,
  diagnosticsSchema,
  modelCatalogSchema,
  modelFamilyLibraryRequestSchema,
  modelInstallRequestSchema,
  modelInstallProgressSchema,
  modelRemoveRequestSchema,
  modelSelectionApplyRequestSchema,
  scratchpadNoteSchema,
  transcribeAudioSchema,
} from "../src/shared/contracts";

describe("IPC contracts", () => {
  it("accepts the local default settings", () => {
    expect(appSettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it("uses the shared history-retention choices as the only persisted values", () => {
    expect(HISTORY_RETENTION_OPTIONS).toEqual([7, 30, 90, 0]);
    for (const historyRetentionDays of HISTORY_RETENTION_OPTIONS) {
      expect(appSettingsSchema.parse({ ...DEFAULT_SETTINGS, historyRetentionDays }).historyRetentionDays)
        .toBe(historyRetentionDays);
    }
    expect(() => appSettingsSchema.parse({ ...DEFAULT_SETTINGS, historyRetentionDays: 14 })).toThrow();
  });

  it("persists only the four user-facing model performance modes", () => {
    expect(MODEL_PERFORMANCE_MODES).toEqual(["auto", "high", "medium", "low"]);
    expect(DEFAULT_SETTINGS.modelPerformanceMode).toBe("auto");
    for (const modelPerformanceMode of MODEL_PERFORMANCE_MODES) {
      expect(appSettingsSchema.parse({ ...DEFAULT_SETTINGS, modelPerformanceMode }).modelPerformanceMode)
        .toBe(modelPerformanceMode);
    }
    expect(() => appSettingsSchema.parse({
      ...DEFAULT_SETTINGS,
      modelPerformanceMode: "ultra",
    })).toThrow();
    expect(appSettingsSchema.parse({
      ...DEFAULT_SETTINGS,
      modelId: "renderer-controlled/model",
    })).not.toHaveProperty("modelId");
  });

  it("keeps active model selection inside a unique curated local library", () => {
    expect(MODEL_FAMILY_IDS).toEqual([
      "parakeet-unified-en-0-6b",
      "whisper-large-v3",
      "qwen3-asr-0-6b",
      "qwen3-asr-1-7b",
      "whisper-large-v2",
    ]);
    expect(DEFAULT_SETTINGS).toMatchObject({
      activeModelFamilyId: "parakeet-unified-en-0-6b",
      modelLibraryFamilyIds: ["parakeet-unified-en-0-6b"],
    });
    expect(() => appSettingsSchema.parse({
      ...DEFAULT_SETTINGS,
      activeModelFamilyId: "whisper-large-v2",
    })).toThrow("active model family must be in the local model library");
    expect(() => appSettingsSchema.parse({
      ...DEFAULT_SETTINGS,
      modelLibraryFamilyIds: ["whisper-large-v3", "whisper-large-v3"],
    })).toThrow("only once");
    expect(() => appSettingsSchema.parse({
      ...DEFAULT_SETTINGS,
      modelLibraryFamilyIds: ["untrusted/model"],
    })).toThrow();
  });

  it("keeps model routing out of generic settings patches", () => {
    expect(appSettingsPatchSchema.parse({ autoPaste: false })).toEqual({ autoPaste: false });
    for (const forbidden of [
      { asrMode: "live" },
      { modelPerformanceMode: "medium" },
      { activeModelFamilyId: "qwen3-asr-0-6b" },
      { modelLibraryFamilyIds: ["whisper-large-v3", "qwen3-asr-0-6b"] },
    ]) {
      expect(() => appSettingsPatchSchema.parse(forbidden)).toThrow();
    }
  });

  it("requires family and performance mode together for an atomic Apply", () => {
    expect(modelSelectionApplyRequestSchema.parse({
      familyId: "qwen3-asr-0-6b",
      performanceMode: "medium",
    })).toEqual({
      familyId: "qwen3-asr-0-6b",
      asrMode: "after-stop",
      performanceMode: "medium",
    });
    expect(() => modelSelectionApplyRequestSchema.parse({
      familyId: "qwen3-asr-0-6b",
    })).toThrow();
    expect(modelSelectionApplyRequestSchema.parse({
      familyId: "parakeet-unified-en-0-6b",
      asrMode: "live",
      performanceMode: "medium",
    })).toEqual({
      familyId: "parakeet-unified-en-0-6b",
      asrMode: "live",
      performanceMode: "medium",
    });
    expect(() => modelSelectionApplyRequestSchema.parse({
      familyId: "qwen3-asr-0-6b",
      performanceMode: "medium",
      modelId: "untrusted/model",
    })).toThrow();
  });

  it("accepts only measured, bounded model-install progress", () => {
    expect(modelInstallProgressSchema.parse({
      familyId: "parakeet-unified-en-0-6b",
      tier: "medium",
      artifactId: "parakeet-unified-en-0-6b-coreml-int8",
      phase: "downloading",
      completedBytes: 128,
      totalBytes: 256,
    })).toMatchObject({ phase: "downloading", completedBytes: 128, totalBytes: 256 });
    expect(modelInstallProgressSchema.parse({
      familyId: "parakeet-unified-en-0-6b",
      tier: "medium",
      artifactId: "parakeet-unified-en-0-6b-coreml-int8",
      phase: "complete",
      completedBytes: 256,
      totalBytes: 256,
      message: "Model downloaded and cryptographically verified.",
    })).toMatchObject({ phase: "complete" });
    expect(() => modelInstallProgressSchema.parse({
      familyId: "parakeet-unified-en-0-6b",
      tier: "medium",
      artifactId: "parakeet-unified-en-0-6b-coreml-int8",
      phase: "downloading",
    })).toThrow(/measured completed and total bytes/u);
    expect(() => modelInstallProgressSchema.parse({
      familyId: "parakeet-unified-en-0-6b",
      tier: "medium",
      artifactId: "parakeet-unified-en-0-6b-coreml-int8",
      phase: "complete",
      completedBytes: 255,
      totalBytes: 256,
    })).toThrow(/full verified artifact size/u);
    expect(() => modelInstallProgressSchema.parse({
      familyId: "parakeet-unified-en-0-6b",
      tier: "medium",
      artifactId: "parakeet-unified-en-0-6b-coreml-int8",
      phase: "failed",
    })).toThrow(/safe user-facing message/u);
  });

  it("requires diagnostics to state whether the resolved tier fits memory", () => {
    const schema = diagnosticsSchema.shape.performance.shape.fitsMemoryBudget;
    expect(schema.parse(true)).toBe(true);
    expect(schema.parse(false)).toBe(false);
    expect(() => schema.parse(undefined)).toThrow();
  });

  it("rejects using the same function key for hold and toggle dictation", () => {
    expect(() => appSettingsSchema.parse({
      ...DEFAULT_SETTINGS,
      holdShortcut: "F13",
      toggleShortcut: "F13",
    })).toThrow("Push-to-talk and toggle dictation must use different shortcuts.");
  });

  it("canonicalizes persisted shortcut aliases and requires an OS-registerable toggle key", () => {
    expect(appSettingsSchema.parse({
      ...DEFAULT_SETTINGS,
      holdShortcut: "ctrl + option + f13",
      toggleShortcut: "cmdorctrl + shift + f14",
    })).toMatchObject({
      holdShortcut: "Control+Alt+F13",
      toggleShortcut: "CommandOrControl+Shift+F14",
    });
    expect(() => appSettingsSchema.parse({
      ...DEFAULT_SETTINGS,
      toggleShortcut: "Control+Shift",
    })).toThrow("Toggle dictation needs a non-modifier key");
  });

  it("rejects unbounded recording durations", () => {
    expect(() =>
      transcribeAudioSchema.parse({
        sessionId: "00000000-0000-4000-8000-000000000001",
        wav: new ArrayBuffer(44),
        durationMs: 10 * 60 * 1000 + 1,
      }),
    ).toThrow();
  });

  it("requires explicit confirmation and a validated concrete tier for model operations", () => {
    expect(modelInstallRequestSchema.parse({
      confirmed: true,
      replaceExisting: false,
      familyId: "whisper-large-v3",
      tier: "medium",
    })).toEqual({
      confirmed: true,
      replaceExisting: false,
      familyId: "whisper-large-v3",
      tier: "medium",
    });
    expect(modelRemoveRequestSchema.parse({
      confirmed: true,
      familyId: "whisper-large-v2",
      tier: "low",
    })).toEqual({
      confirmed: true,
      familyId: "whisper-large-v2",
      tier: "low",
    });
    expect(() => modelInstallRequestSchema.parse({
      confirmed: false,
      replaceExisting: false,
      familyId: "whisper-large-v3",
      tier: "medium",
    })).toThrow();
    expect(() => modelInstallRequestSchema.parse({
      confirmed: true,
      replaceExisting: false,
      familyId: "whisper-large-v3",
      tier: "auto",
    })).toThrow();
    expect(() => modelRemoveRequestSchema.parse({
      confirmed: true,
      familyId: "whisper-large-v3",
      tier: "other",
    })).toThrow();
    expect(() => modelInstallRequestSchema.parse({
      confirmed: true,
      replaceExisting: false,
      familyId: "whisper-large-v3",
      tier: "medium",
      extra: true,
    })).toThrow();
    expect(() => modelInstallRequestSchema.parse({
      confirmed: true,
      replaceExisting: false,
      familyId: "untrusted/model",
      tier: "medium",
    })).toThrow();
    expect(modelFamilyLibraryRequestSchema.parse({ familyId: "whisper-large-v2" })).toEqual({
      familyId: "whisper-large-v2",
    });
    expect(() => modelFamilyLibraryRequestSchema.parse({
      familyId: "https://untrusted.invalid/model",
    })).toThrow();
  });

  it("requires one internally consistent verification for every curated model artifact", () => {
    const artifactId = "parakeet-unified-en-0-6b-coreml-int8";
    const verification = {
      familyId: "parakeet-unified-en-0-6b" as const,
      artifactId,
      present: false,
      verified: false,
      verificationStatus: "missing" as const,
      sizeBytes: 0,
      expectedBytes: 1,
      verifiedFiles: 0,
      expectedFiles: 1,
    };
    const catalog = {
      platform: "darwin-arm64" as const,
      activeModelFamilyId: "parakeet-unified-en-0-6b" as const,
      modelLibraryFamilyIds: ["parakeet-unified-en-0-6b" as const],
      recommendedDefaultFamilyId: "parakeet-unified-en-0-6b" as const,
      families: [{
        familyId: "parakeet-unified-en-0-6b" as const,
        displayName: "Parakeet Unified EN 0.6B",
        capabilities: {
          modes: ["after-stop", "live"] as const,
          partialResults: true,
          timestamps: true,
          languageDetection: false,
          promptContext: false,
          keywordBoost: false,
          supportedLanguages: ["en"],
        },
        recommendedDefault: true,
        active: true,
        inLibrary: true,
        artifacts: [{
          artifactId,
          displayName: "Parakeet Unified EN 0.6B Medium",
          backend: "FluidAudio/Core ML",
          modelId: "FluidInference/parakeet-tdt-0.6b-v3-coreml",
          storageDirectory: artifactId,
          revision: "a".repeat(40),
          license: "CC-BY-4.0",
          expectedDownloadBytes: 1,
        }],
        profiles: [{
          profileId: "parakeet-unified-en-0-6b-medium",
          tier: "medium" as const,
          artifactId,
          engine: "fluid-audio" as const,
          precision: "int8",
          expectedMemoryMinBytes: 1,
          expectedMemoryMaxBytes: 2,
          memoryBasis: "estimated" as const,
        }],
      }],
      verifications: [verification],
      unmanagedEntries: [],
    };

    expect(modelCatalogSchema.parse(catalog).verifications).toHaveLength(1);
    expect(() => modelCatalogSchema.parse({
      ...catalog,
      verifications: [],
    })).toThrow("Every curated artifact must have one verification result");
    expect(() => modelCatalogSchema.parse({
      ...catalog,
      verifications: [verification, verification],
    })).toThrow("Duplicate artifact verification");
    expect(() => modelCatalogSchema.parse({
      ...catalog,
      verifications: [{ ...verification, present: true }],
    })).toThrow("presence state is inconsistent");
    expect(() => modelCatalogSchema.parse({
      ...catalog,
      families: [{
        ...catalog.families[0],
        profiles: [{
          ...catalog.families[0]!.profiles[0],
          artifactId: "missing-artifact",
        }],
      }],
    })).toThrow("Profile does not reference a curated family artifact");
  });

  it("accepts scratchpad notes with a derived title and bounded body", () => {
    expect(
      scratchpadNoteSchema.parse({
        id: "00000000-0000-4000-8000-000000000001",
        body: "First line\nSecond line",
        title: "First line",
        createdAt: 1,
        updatedAt: 1,
      }),
    ).toMatchObject({ title: "First line" });
  });
});
