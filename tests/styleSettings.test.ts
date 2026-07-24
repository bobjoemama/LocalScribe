import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  cleanupSelectionForSettings,
  GENERATIVE_TEXT_MODEL_REQUIRED_NOTICE,
  modelActionFailureMessage,
  modelInstallRequest,
  modelPerformanceSaveMessage,
  modelRemoveRequest,
  modelRuntimeTierStatuses,
  SettingsModal,
  SETTINGS_TABS,
  settingsControlAvailability,
  settingsLoadPresentation,
  shortcutCommitErrorMessage,
  StyleScreen,
  TransformsScreen,
  UNAVAILABLE_IN_THIS_BUILD_NOTICE,
} from "../src/renderer/settings/screens/StyleSettings";
import {
  DICTATION_LANGUAGE_DETAIL,
  DICTATION_LANGUAGE_OPTIONS,
} from "../src/renderer/settings/dictationLanguages";
import {
  formatAcceleratorBytes,
  formatMemoryRange,
  formatModelBytes,
  MODEL_MODE_CHOICES,
  modelVerificationPresentation,
  platformModelCopy,
} from "../src/renderer/settings/screens/ModelPerformanceSettings";

describe("feature availability copy", () => {
  it("keeps model-gated and unimplemented features distinct", () => {
    expect(GENERATIVE_TEXT_MODEL_REQUIRED_NOTICE).toBe(
      "Additional generative text model required — not installed",
    );
    expect(UNAVAILABLE_IN_THIS_BUILD_NOTICE).toBe("Unavailable in this build");
  });
});

describe("settings loading truthfulness", () => {
  it("keeps settings-dependent controls disabled until persisted settings load", () => {
    const loading = settingsControlAvailability(null, null);
    expect(loading).toEqual({
      enabled: false,
      presentation: {
        title: "Loading settings",
        detail: "Your saved settings are loading. Controls will be available when that finishes.",
        isError: false,
      },
    });

    const rejected = settingsControlAvailability(null, new Error("database unavailable"));
    expect(rejected).toEqual({
      enabled: false,
      presentation: {
        title: "Settings unavailable",
        detail: "Could not load saved settings: database unavailable",
        isError: true,
      },
    });
  });

  it("renders loading truthfully while leaving profiles and dictionary rules independently available", () => {
    const styleHtml = renderToStaticMarkup(createElement(StyleScreen));
    expect(styleHtml).toContain("Loading settings");
    expect(styleHtml).toContain("+ Add profile");

    const transformsHtml = renderToStaticMarkup(createElement(TransformsScreen));
    expect(transformsHtml).toContain("Loading settings");
    expect(transformsHtml).toContain("Available when saved settings load");
    expect(transformsHtml).toContain('disabled=""');
    expect(transformsHtml).toContain('placeholder="road map"');
  });

  it("keeps persisted settings unavailable rather than rendering writable defaults", () => {
    expect(settingsLoadPresentation(null, null)).toEqual({
      title: "Loading settings",
      detail: "Your saved settings are loading. Controls will be available when that finishes.",
      isError: false,
    });
    expect(settingsLoadPresentation(null, new Error("database unavailable"))).toEqual({
      title: "Settings unavailable",
      detail: "Could not load saved settings: database unavailable",
      isError: true,
    });

    const html = renderToStaticMarkup(createElement(SettingsModal, { onClose: () => undefined }));
    expect(html).toContain("Loading settings");
    expect(html).toContain("Controls will be available when that finishes.");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('value="Control"');
    expect(html).not.toContain("Push-to-talk shortcut");
  });

  it("uses a platform-neutral shortcut commit fallback", () => {
    expect(shortcutCommitErrorMessage()).toBe(
      "Could not apply that shortcut. Choose another key combination or try again.",
    );
    expect(shortcutCommitErrorMessage()).not.toMatch(/macOS|Windows|System Settings/i);
  });
});

describe("dictation language choices", () => {
  it("keeps the common verified choices in one renderer list", () => {
    expect(DICTATION_LANGUAGE_OPTIONS).toEqual([
      { value: "auto", label: "Auto-detect" },
      { value: "English", label: "English" },
      { value: "Spanish", label: "Spanish" },
      { value: "French", label: "French" },
      { value: "German", label: "German" },
      { value: "Hindi", label: "Hindi" },
    ]);
    expect(DICTATION_LANGUAGE_DETAIL).toBe(
      "Auto-detect or select one of the languages supported in this build.",
    );
  });
});

describe("cleanup level display", () => {
  it("recognizes the three exact preset combinations", () => {
    expect(cleanupSelectionForSettings({
      removeFillers: false,
      spokenCommands: false,
      smartPunctuation: false,
    })).toBe("none");
    expect(cleanupSelectionForSettings({
      removeFillers: false,
      spokenCommands: true,
      smartPunctuation: true,
    })).toBe("light");
    expect(cleanupSelectionForSettings({
      removeFillers: true,
      spokenCommands: true,
      smartPunctuation: true,
    })).toBe("medium");
  });

  it("does not mislabel independently configured switches as a preset", () => {
    expect(cleanupSelectionForSettings({
      removeFillers: true,
      spokenCommands: false,
      smartPunctuation: true,
    })).toBe("custom");
    expect(cleanupSelectionForSettings({
      removeFillers: false,
      spokenCommands: true,
      smartPunctuation: false,
    })).toBe("custom");
  });
});

describe("model and performance presentation", () => {
  it("adds Model & Performance as the sixth settings tab", () => {
    expect(SETTINGS_TABS.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "general", label: "General" },
      { id: "system", label: "System" },
      { id: "model", label: "Model & Performance" },
      { id: "writing", label: "Writing" },
      { id: "experimental", label: "Experimental" },
      { id: "privacy", label: "Data & Privacy" },
    ]);
  });

  it("offers exactly Auto, High, Medium, and Low in that order", () => {
    expect(MODEL_MODE_CHOICES).toEqual([
      { id: "auto", label: "Auto" },
      { id: "high", label: "High" },
      { id: "medium", label: "Medium" },
      { id: "low", label: "Low" },
    ]);
  });

  it("uses platform-accurate backend and memory language", () => {
    expect(platformModelCopy("darwin")).toEqual({
      summary: "Auto uses available unified memory to choose the best MLX tier for this Mac.",
      memoryLabel: "Unified memory",
    });
    expect(platformModelCopy("win32")).toEqual({
      summary: "Auto uses available NVIDIA VRAM to choose the best faster-whisper tier for this PC.",
      memoryLabel: "NVIDIA VRAM",
    });
  });

  it("distinguishes verified, missing, and damaged installations", () => {
    expect(modelVerificationPresentation("verified")).toEqual({
      label: "Verified",
      tone: "ready",
    });
    expect(modelVerificationPresentation("missing")).toEqual({
      label: "Missing",
      tone: "missing",
    });
    expect(modelVerificationPresentation("invalid")).toEqual({
      label: "Repair required",
      tone: "repair",
    });
  });

  it("labels accelerator memory evidence without implying a measurement", () => {
    expect(formatMemoryRange({
      minimumBytes: 3 * 1_073_741_824,
      maximumBytes: 4.5 * 1_073_741_824,
      basis: "measured",
    })).toBe("3.00 GiB–4.50 GiB measured");
    expect(formatMemoryRange({
      minimumBytes: 8 * 1_073_741_824,
      maximumBytes: 8 * 1_073_741_824,
      basis: "estimated",
    })).toBe("8.00 GiB estimated");
    expect(formatAcceleratorBytes(16 * 1_073_741_824)).toBe("16.0 GiB");
    expect(formatModelBytes(12_000_000_000)).toBe("12.0 GB");
  });

  it("does not claim Auto resolved to the internal Low sentinel when no tier fits", () => {
    expect(modelPerformanceSaveMessage("auto", {
      fitsMemoryBudget: false,
      resolvedTier: "low",
    })).toBe(
      "Auto saved, but no tier fits the current memory budget. Dictation stays blocked until enough memory is available.",
    );
    expect(modelPerformanceSaveMessage("auto", {
      fitsMemoryBudget: true,
      resolvedTier: "medium",
    })).toContain("resolved to Medium");
  });

  it("builds strict family-scoped install and remove requests", () => {
    expect(modelInstallRequest("whisper-large-v2", "medium", true)).toEqual({
      confirmed: true,
      familyId: "whisper-large-v2",
      tier: "medium",
      replaceExisting: true,
    });
    expect(modelRemoveRequest("whisper-large-v3", "low")).toEqual({
      confirmed: true,
      familyId: "whisper-large-v3",
      tier: "low",
    });
  });

  it("tags runtime statuses with the diagnostic family instead of stale settings state", () => {
    const statuses = modelRuntimeTierStatuses({
      model: { familyId: "whisper-large-v2" },
      performance: {
        options: [{
          tier: "high",
          artifactId: "whisper-large-v2-mlx-fp16",
          qualityNote: "Curated v2 profile.",
          verificationStatus: "verified",
        }],
      },
    } as never);
    expect(statuses).toEqual([{
      familyId: "whisper-large-v2",
      tier: "high",
      artifactId: "whisper-large-v2-mlx-fp16",
      qualityNote: "Curated v2 profile.",
      verificationStatus: "verified",
    }]);
  });

  it("makes a known insufficient-memory failure show the reported requirement and reserve", () => {
    expect(modelActionFailureMessage(
      "install",
      new Error("high mode needs 9 GiB of free accelerator memory including reserved headroom; 4 GiB is currently available."),
      {
        performance: { requiredFreeMemoryBytes: 9 * 1_073_741_824, reservedHeadroomBytes: 2 * 1_073_741_824 },
        accelerator: { freeMemoryBytes: 4 * 1_073_741_824 },
      } as never,
    )).toContain("requires 9.00 GiB free accelerator memory, including 2.00 GiB reserved headroom; LocalScribe currently reports 4.00 GiB available");
  });
});
