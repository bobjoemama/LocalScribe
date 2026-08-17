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
      activeModelFamilyId: "whisper-large-v3",
      modelLibraryFamilyIds: ["whisper-large-v3"],
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
    const profiles = (
      familyId: "whisper-large-v3" | "whisper-large-v2",
      artifactId: string,
    ) => (["high", "medium", "low"] as const).map((tier) => ({
      profileId: `${familyId}-${tier}`,
      tier,
      artifactId,
      engine: "faster-whisper" as const,
      precision: tier === "high" ? "float16" : tier === "medium" ? "int8_float16" : "int8",
      expectedMemoryMinBytes: 1,
      expectedMemoryMaxBytes: 2,
      memoryBasis: "estimated" as const,
    }));
    const artifact = (artifactId: string, modelId: string) => ({
      artifactId,
      displayName: modelId,
      backend: "faster-whisper/CTranslate2",
      modelId,
      storageDirectory: artifactId,
      revision: "a".repeat(40),
      license: "MIT",
      expectedDownloadBytes: 1,
    });
    const verification = (
      familyId: "whisper-large-v3" | "qwen3-asr-0-6b" | "qwen3-asr-1-7b" | "whisper-large-v2",
      artifactId: string,
    ) => ({
      familyId,
      artifactId,
      present: false,
      verified: false,
      verificationStatus: "missing" as const,
      sizeBytes: 0,
      expectedBytes: 1,
      verifiedFiles: 0,
      expectedFiles: 1,
    });
    const catalog = {
      platform: "win32-x64-cuda" as const,
      activeModelFamilyId: "whisper-large-v3" as const,
      modelLibraryFamilyIds: ["whisper-large-v3" as const],
      recommendedDefaultFamilyId: "whisper-large-v3" as const,
      families: [
        {
          familyId: "whisper-large-v3" as const,
          displayName: "Whisper large-v3",
          capabilities: { modes: ["after-stop"], partialResults: false, timestamps: false, languageDetection: false, promptContext: false, keywordBoost: false, supportedLanguages: ["auto"] },
          recommendedDefault: true,
          active: true,
          inLibrary: true,
          artifacts: [artifact("whisper-large-v3-ctranslate2", "Systran/faster-whisper-large-v3")],
          profiles: profiles("whisper-large-v3", "whisper-large-v3-ctranslate2"),
        },
        {
          familyId: "qwen3-asr-0-6b" as const,
          displayName: "Qwen3-ASR 0.6B",
          capabilities: { modes: ["after-stop"], partialResults: false, timestamps: false, languageDetection: false, promptContext: false, keywordBoost: false, supportedLanguages: ["auto"] },
          recommendedDefault: false,
          active: false,
          inLibrary: false,
          artifacts: (["f16", "q8-0", "q4-k"] as const).map((quant) => ({
            ...artifact(
              `qwen3-asr-0-6b-crisp-${quant}`,
              "cstr/qwen3-asr-0.6b-GGUF",
            ),
            backend: "CrispASR CUDA",
            storageDirectory: `qwen3-asr-0-6b-crisp-${quant}`,
          })),
          profiles: (["high", "medium", "low"] as const).map((tier, index) => ({
            profileId: `qwen3-asr-0-6b-${tier}`,
            tier,
            artifactId: [
              "qwen3-asr-0-6b-crisp-f16",
              "qwen3-asr-0-6b-crisp-q8-0",
              "qwen3-asr-0-6b-crisp-q4-k",
            ][index],
            engine: "crispasr" as const,
            precision: ["float16", "q8_0", "q4_k"][index],
            expectedMemoryMinBytes: 1,
            expectedMemoryMaxBytes: 2,
            memoryBasis: "estimated" as const,
          })),
        },
        {
          familyId: "qwen3-asr-1-7b" as const,
          displayName: "Qwen3-ASR 1.7B",
          capabilities: { modes: ["after-stop"], partialResults: false, timestamps: false, languageDetection: false, promptContext: false, keywordBoost: false, supportedLanguages: ["auto"] },
          recommendedDefault: false,
          active: false,
          inLibrary: false,
          artifacts: (["f16", "q8-0", "q4-k"] as const).map((quant) => ({
            ...artifact(
              `qwen3-asr-1-7b-crisp-${quant}`,
              "cstr/qwen3-asr-1.7b-GGUF",
            ),
            backend: "CrispASR CUDA",
            storageDirectory: `qwen3-asr-1-7b-crisp-${quant}`,
          })),
          profiles: (["high", "medium", "low"] as const).map((tier, index) => ({
            profileId: `qwen3-asr-1-7b-${tier}`,
            tier,
            artifactId: [
              "qwen3-asr-1-7b-crisp-f16",
              "qwen3-asr-1-7b-crisp-q8-0",
              "qwen3-asr-1-7b-crisp-q4-k",
            ][index],
            engine: "crispasr" as const,
            precision: ["float16", "q8_0", "q4_k"][index],
            expectedMemoryMinBytes: 1,
            expectedMemoryMaxBytes: 2,
            memoryBasis: "estimated" as const,
          })),
        },
        {
          familyId: "whisper-large-v2" as const,
          displayName: "Whisper large-v2",
          capabilities: { modes: ["after-stop"], partialResults: false, timestamps: false, languageDetection: false, promptContext: false, keywordBoost: false, supportedLanguages: ["auto"] },
          recommendedDefault: false,
          active: false,
          inLibrary: false,
          artifacts: [artifact("whisper-large-v2-ctranslate2", "Systran/faster-whisper-large-v2")],
          profiles: profiles("whisper-large-v2", "whisper-large-v2-ctranslate2"),
        },
      ],
      verifications: [
        verification("whisper-large-v3", "whisper-large-v3-ctranslate2"),
        verification("qwen3-asr-0-6b", "qwen3-asr-0-6b-crisp-f16"),
        verification("qwen3-asr-0-6b", "qwen3-asr-0-6b-crisp-q8-0"),
        verification("qwen3-asr-0-6b", "qwen3-asr-0-6b-crisp-q4-k"),
        verification("qwen3-asr-1-7b", "qwen3-asr-1-7b-crisp-f16"),
        verification("qwen3-asr-1-7b", "qwen3-asr-1-7b-crisp-q8-0"),
        verification("qwen3-asr-1-7b", "qwen3-asr-1-7b-crisp-q4-k"),
        verification("whisper-large-v2", "whisper-large-v2-ctranslate2"),
      ],
      unmanagedEntries: [],
    };

    expect(modelCatalogSchema.parse(catalog).verifications).toHaveLength(8);
    expect(() => modelCatalogSchema.parse({
      ...catalog,
      verifications: catalog.verifications.slice(0, 1),
    })).toThrow("Every curated artifact must have one verification result");
    expect(() => modelCatalogSchema.parse({
      ...catalog,
      verifications: [
        ...catalog.verifications,
        catalog.verifications[0],
      ],
    })).toThrow("Duplicate artifact verification");
    expect(() => modelCatalogSchema.parse({
      ...catalog,
      verifications: [{
        ...catalog.verifications[0],
        present: true,
      }, catalog.verifications[1]],
    })).toThrow("presence state is inconsistent");
    expect(() => modelCatalogSchema.parse({
      ...catalog,
      families: [{
        ...catalog.families[0],
        profiles: catalog.families[0]!.profiles.map((profile, index) => index === 0
          ? { ...profile, artifactId: "missing-artifact" }
          : profile),
      }, catalog.families[1]],
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
