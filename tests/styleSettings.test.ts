import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  type AppSettingsPatch,
} from "../src/shared/contracts";
import {
  appProfilePresentation,
  automaticPasteSettingsPresentation,
  cleanupSelectionForSettings,
  GENERATIVE_TEXT_MODEL_REQUIRED_NOTICE,
  modelActionFailureMessage,
  modelArtifactScopePresentation,
  modelInstallRequest,
  modelPerformanceSaveMessage,
  modelRemoveRequest,
  modelRuntimeTierStatuses,
  launchAtLoginSettingsPresentation,
  pendingSettingsAfterSave,
  profileCleanupDefaults,
  resolvedModelEngine,
  selectedMicrophoneIsUnavailable,
  SettingsModal,
  SETTINGS_TABS,
  settingsControlAvailability,
  settingsLoadPresentation,
  settingsWithPendingDraft,
  shortcutHelpText,
  shortcutCommitErrorMessage,
  StyleScreen,
  TransformsScreen,
  UNAVAILABLE_IN_THIS_BUILD_NOTICE,
} from "../src/renderer/settings/screens/StyleSettings";
import {
  DICTATION_LANGUAGE_DETAIL,
  DICTATION_LANGUAGE_OPTIONS,
  dictationLanguageOptionsFor,
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
      "Unavailable in this build — no local text-model integration",
    );
    expect(UNAVAILABLE_IN_THIS_BUILD_NOTICE).toBe("Unavailable in this build");
  });
});

describe("app profile presentation", () => {
  it("uses runtime-platform app identity examples instead of a macOS-only fixture", () => {
    expect(appProfilePresentation("darwin")).toEqual({
      detail: "Override cleanup for a macOS app bundle identifier.",
      labelPlaceholder: "TextEdit",
      appIdPlaceholder: "com.apple.TextEdit",
    });
    expect(appProfilePresentation("win32")).toEqual({
      detail: "Override cleanup for a Windows executable name.",
      labelPlaceholder: "Notepad",
      appIdPlaceholder: "notepad.exe",
    });
    expect(appProfilePresentation(null)).toEqual({
      detail: "Override cleanup for an application identifier reported by this platform.",
      labelPlaceholder: "App name",
      appIdPlaceholder: "Application identifier",
    });
  });

  it("inherits new profile cleanup choices from the loaded global settings", () => {
    expect(profileCleanupDefaults({
      ...DEFAULT_SETTINGS,
      removeFillers: false,
      spokenCommands: true,
      smartPunctuation: false,
    })).toEqual({
      removeFillers: false,
      spokenCommands: true,
      smartPunctuation: false,
    });
    expect(profileCleanupDefaults(null)).toEqual({
      removeFillers: DEFAULT_SETTINGS.removeFillers,
      spokenCommands: DEFAULT_SETTINGS.spokenCommands,
      smartPunctuation: DEFAULT_SETTINGS.smartPunctuation,
    });
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

  it("keeps Windows automatic paste copy-only until its local helper is ready", () => {
    const unavailable = automaticPasteSettingsPresentation({
      platform: "win32",
      automaticPaste: { supported: true, ready: false },
    } as never);
    expect(unavailable).toEqual({
      editable: false,
      detail: "The local Windows paste helper is unavailable. Completed dictation will be copied until the helper is available.",
      value: "Copy only",
    });

    expect(automaticPasteSettingsPresentation({
      platform: "win32",
      automaticPaste: { supported: true, ready: true },
    } as never)).toMatchObject({
      editable: true,
      value: null,
    });
    expect(automaticPasteSettingsPresentation(null)).toMatchObject({
      editable: false,
      value: "Checking",
    });
  });

  it("redacts machine paths and technical details from visible Settings errors", () => {
    expect(settingsLoadPresentation(
      null,
      new Error("SQLITE_CANTOPEN: C:\\Users\\Alice\\AppData\\Local\\LocalScribe\\localscribe.db"),
    )).toEqual({
      title: "Settings unavailable",
      detail: "Could not load saved settings: The local operation failed. Try again.",
      isError: true,
    });
    expect(modelActionFailureMessage(
      "install",
      new Error("Error\n    at installModel (C:\\Users\\Alice\\LocalScribe\\model.ts:42:7)"),
      null,
    )).toBe(
      "Could not download this curated model profile: The local operation failed. Try again.",
    );
  });

  it("uses the trusted runtime platform for push-to-talk labels and Windows recovery", () => {
    const windowsPermissions = {
      platform: "win32",
      globalHold: { ready: false },
      accessibility: { granted: false },
    } as const;
    expect(shortcutHelpText(windowsPermissions as never, "Control+Shift")).toBe(
      "The current push-to-talk key is Control + Shift. The Windows global keyboard hook is not running; restart LocalScribe or use the toggle shortcut.",
    );
    expect(shortcutHelpText({
      platform: "win32",
      globalHold: { ready: true },
      accessibility: { granted: false },
    } as never, "Control")).toBe(
      "Shortcut changes apply immediately. Hold Control to dictate from any app.",
    );
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

  it("keeps an older saved language visible instead of rendering a blank selection", () => {
    expect(dictationLanguageOptionsFor("German")).toBe(DICTATION_LANGUAGE_OPTIONS);
    expect(dictationLanguageOptionsFor("Italian")[0]).toEqual({
      value: "Italian",
      label: "Italian (saved; not offered in this build)",
    });
  });
});

describe("settings draft reconciliation", () => {
  it("merges external persisted changes without discarding pending local fields", () => {
    expect(settingsWithPendingDraft(
      { ...DEFAULT_SETTINGS, microphoneId: "external-device" },
      { language: "German", showPillWhenIdle: false },
    )).toMatchObject({
      microphoneId: "external-device",
      language: "German",
      showPillWhenIdle: false,
    });
  });

  it("acknowledges only submitted values that were not edited again during save", () => {
    const submitted: AppSettingsPatch = {
      language: "German",
      showPillWhenIdle: false,
    };
    expect(pendingSettingsAfterSave({
      language: "French",
      showPillWhenIdle: false,
      autoPaste: false,
    }, submitted)).toEqual({
      language: "French",
      autoPaste: false,
    });
  });

  it("marks a persisted microphone that is no longer enumerated as unavailable", () => {
    expect(selectedMicrophoneIsUnavailable("usb-mic", [{ deviceId: "built-in" }])).toBe(true);
    expect(selectedMicrophoneIsUnavailable("usb-mic", [{ deviceId: "usb-mic" }])).toBe(false);
    expect(selectedMicrophoneIsUnavailable(null, [])).toBe(false);
  });
});

describe("launch-at-login operating system state", () => {
  it("does not claim enabled while macOS still requires approval", () => {
    expect(launchAtLoginSettingsPresentation(true, {
      supported: true,
      registered: true,
      effective: false,
      requiresApproval: true,
      status: "requires-approval",
    })).toEqual({
      editable: true,
      value: false,
      detail: "Saved as on, but macOS requires approval in System Settings. Turn this on and save to request registration again.",
    });
  });

  it("does not claim enabled when Windows externally disabled the startup item", () => {
    expect(launchAtLoginSettingsPresentation(true, {
      supported: true,
      registered: true,
      effective: false,
      requiresApproval: false,
      status: "disabled",
    })).toEqual({
      editable: true,
      value: false,
      detail: "Saved as on, but disabled in the operating system's startup settings. Turn this on and save to register it again.",
    });
  });

  it("shows a staged re-registration request before it is saved", () => {
    expect(launchAtLoginSettingsPresentation(true, {
      supported: true,
      registered: true,
      effective: false,
      requiresApproval: false,
      status: "disabled",
    }, true)).toEqual({
      editable: true,
      value: true,
      detail: "Save changes to apply this login startup setting to the operating system.",
    });
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

  it("uses platform-accurate memory language without assuming a model backend", () => {
    expect(platformModelCopy("darwin")).toEqual({
      summary: "Auto uses available unified memory to choose the highest profile that fits in the active family.",
      memoryLabel: "Unified memory",
    });
    expect(platformModelCopy("win32")).toEqual({
      summary: "Auto uses available NVIDIA VRAM to choose the highest profile that fits in the active family.",
      memoryLabel: "NVIDIA VRAM",
    });
  });

  it("shows the backend reported by diagnostics instead of inferring one from a tier or platform", () => {
    expect(resolvedModelEngine(null)).toBe("Checking");
    expect(resolvedModelEngine({
      platform: "darwin",
      backend: "MLX Whisper from the active manifest",
      performance: {
        resolvedTier: "medium",
        options: [{ tier: "medium", engine: "internal-engine-slug" }],
      },
    } as never)).toBe("MLX Whisper from the active manifest");
    expect(resolvedModelEngine({
      platform: "win32",
      backend: "faster-whisper/CTranslate2 from the active manifest",
      performance: {
        resolvedTier: "low",
        options: [],
      },
    } as never)).toBe("faster-whisper/CTranslate2 from the active manifest");
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

  it("uses artifact verification for inactive families and every profile sharing model data", () => {
    const statuses = modelRuntimeTierStatuses(
      {
        model: { familyId: "whisper-large-v3" },
        performance: {
          options: [{
            tier: "high",
            artifactId: "whisper-large-v3-high",
            qualityNote: "Active v3 profile.",
            verificationStatus: "verified",
          }],
        },
      } as never,
      {
        families: [
          {
            familyId: "whisper-large-v3",
            profiles: [{
              tier: "high",
              artifactId: "whisper-large-v3-high",
            }],
          },
          {
            familyId: "whisper-large-v2",
            profiles: (["high", "medium", "low"] as const).map((tier) => ({
              tier,
              artifactId: "whisper-large-v2-shared",
            })),
          },
        ],
        verifications: [
          {
            familyId: "whisper-large-v3",
            artifactId: "whisper-large-v3-high",
            verificationStatus: "verified",
          },
          {
            familyId: "whisper-large-v2",
            artifactId: "whisper-large-v2-shared",
            verificationStatus: "invalid",
          },
        ],
      } as never,
    );

    expect(statuses).toEqual([
      {
        familyId: "whisper-large-v3",
        tier: "high",
        artifactId: "whisper-large-v3-high",
        qualityNote: "Active v3 profile.",
        verificationStatus: "verified",
      },
      {
        familyId: "whisper-large-v2",
        tier: "high",
        artifactId: "whisper-large-v2-shared",
        qualityNote: undefined,
        verificationStatus: "invalid",
      },
      {
        familyId: "whisper-large-v2",
        tier: "medium",
        artifactId: "whisper-large-v2-shared",
        qualityNote: undefined,
        verificationStatus: "invalid",
      },
      {
        familyId: "whisper-large-v2",
        tier: "low",
        artifactId: "whisper-large-v2-shared",
        qualityNote: undefined,
        verificationStatus: "invalid",
      },
    ]);
  });

  it("explains when one physical model artifact is shared by every performance profile", () => {
    const shared = modelArtifactScopePresentation({
      families: [{
        familyId: "whisper-large-v3",
        displayName: "Whisper large-v3",
        profiles: (["high", "medium", "low"] as const).map((tier) => ({
          tier,
          artifactId: "whisper-large-v3-shared",
        })),
        artifacts: [{
          artifactId: "whisper-large-v3-shared",
        }],
      }],
    } as never, "whisper-large-v3", "high");
    const distinct = modelArtifactScopePresentation({
      families: [{
        familyId: "whisper-large-v3",
        displayName: "Whisper large-v3",
        profiles: [{
          tier: "high",
          artifactId: "whisper-large-v3-high",
        }],
        artifacts: [{
          artifactId: "whisper-large-v3-high",
        }],
      }],
    } as never, "whisper-large-v3", "high");

    expect(shared).toMatchObject({
      sharedAcrossTiers: true,
      confirmationTarget: "Whisper large-v3 shared model data for all performance profiles",
      removalTarget: "the Whisper large-v3 shared local model data used by all performance profiles",
    });
    expect(distinct).toMatchObject({
      sharedAcrossTiers: false,
      confirmationTarget: "Whisper large-v3 High profile",
      removalTarget: "the Whisper large-v3 High profile",
    });
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
