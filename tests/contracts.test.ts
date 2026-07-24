import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  HISTORY_RETENTION_OPTIONS,
  MODEL_PERFORMANCE_MODES,
  appSettingsSchema,
  diagnosticsSchema,
  modelFamilyLibraryRequestSchema,
  modelInstallRequestSchema,
  modelRemoveRequestSchema,
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
