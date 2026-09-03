import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { expectPrecedes, requireIndex } from "./support/order";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type AppSettingsPatch,
} from "../src/shared/contracts";
import {
  appProfilePresentation,
  automaticPasteSettingsPresentation,
  appliedModelSelectionMessage,
  cleanupSelectionForSettings,
  GENERATIVE_TEXT_MODEL_REQUIRED_NOTICE,
  modelActionFailureMessage,
  modelActionWithInstallProgress,
  modelArtifactScopePresentation,
  modelInstallRequest,
  modelPerformanceSaveMessage,
  modelRemoveRequest,
  modelRuntimeTierStatuses,
  launchAtLoginSettingsPresentation,
  pendingSettingsAfterSave,
  profileCleanupDefaults,
  residentModelMatchesSavedSelection,
  resolvedModelEngine,
  selectedMicrophoneIsUnavailable,
  SettingsModal,
  SETTINGS_TABS,
  settingsControlAvailability,
  settingsHistoryExportMessage,
  settingsLoadPresentation,
  settingsWithPendingDraft,
  shortcutHelpText,
  shortcutCommitErrorMessage,
  StyleScreen,
  subscribeToSettingsWithInitialLoad,
  TOGGLE_UNREGISTERED_ADVICE,
  TransformsScreen,
  UNAVAILABLE_IN_THIS_BUILD_NOTICE,
} from "../src/renderer/settings/screens/StyleSettings";
import {
  DICTATION_LANGUAGE_DETAIL,
  DICTATION_LANGUAGE_OPTIONS,
  dictationLanguagePresentation,
  dictationLanguageOptionsFor,
} from "../src/renderer/settings/dictationLanguages";
import {
  formatAcceleratorBytes,
  formatMemoryRange,
  formatModelBytes,
  MODEL_MODE_CHOICES,
  modelVerificationPresentation,
  modelMemoryCopy,
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
  it("uses macOS bundle identity examples", () => {
    expect(appProfilePresentation()).toEqual({
      detail: "Override cleanup for a macOS app bundle identifier.",
      labelPlaceholder: "TextEdit",
      appIdPlaceholder: "com.apple.TextEdit",
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
    expect(shortcutCommitErrorMessage()).not.toMatch(/macOS|System Settings/i);
  });

  it("waits for macOS automatic paste availability", () => {
    expect(automaticPasteSettingsPresentation(null)).toMatchObject({
      editable: false,
      value: "Checking",
    });
  });

  /*
   * The setting told a macOS user without Accessibility that dictation would be
   * pasted "only when the app active at start is still the target" — a
   * description of behaviour that cannot happen: main takes the copy path and
   * the pill already says "Copied — allow Accessibility".
   *
   * `automaticPaste.ready` is `accessibilityGranted` on darwin
   * (platformCapabilities.ts), so this state is every Mac that has not been
   * granted Accessibility yet — the state every new install starts in.
   */
  it("does not promise a macOS user paste that Accessibility denial makes impossible", () => {
    const denied = automaticPasteSettingsPresentation({
      platform: "darwin",
      automaticPaste: { supported: true, ready: false },
    } as never);

    expect(denied.detail).toMatch(/copied/iu);
    expect(denied.detail).toMatch(/Accessibility/u);
    // The wording that was wrong: it describes pasting as the outcome.
    expect(denied.detail).not.toMatch(/Paste only when/u);
  });

  it("keeps the macOS switch usable so the preference survives granting access", () => {
    // Accessibility is a permission the user can grant, and the preference has
    // to already be set for granting it to do anything.
    expect(automaticPasteSettingsPresentation({
      platform: "darwin",
      automaticPaste: { supported: true, ready: false },
    } as never)).toMatchObject({ editable: true, value: null });
  });

  it("describes the target check once Accessibility is granted", () => {
    expect(automaticPasteSettingsPresentation({
      platform: "darwin",
      automaticPaste: { supported: true, ready: true },
    } as never)).toEqual({
      editable: true,
      detail: "Best-effort paste rechecks the app and editor immediately before sending Command-V. If macOS changes focus at the final handoff, the dictated text remains copied as a fallback.",
      value: null,
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

  it("reports a completed history export without persisting its absolute path", () => {
    expect(settingsHistoryExportMessage("/Users/Alice/Documents/private-history.json"))
      .toBe("History exported locally.");
    expect(settingsHistoryExportMessage("C:\\Users\\Alice\\Documents\\private-history.json"))
      .toBe("History exported locally.");
    expect(settingsHistoryExportMessage(null)).toBe("Export cancelled");
  });

});

describe("settings initial snapshot ordering", () => {
  it("subscribes before get and ignores a stale initial snapshot after a pushed change", async () => {
    const calls: string[] = [];
    const applied: AppSettings[] = [];
    const errors: unknown[] = [];
    let changedListener!: (settings: AppSettings) => void;
    let resolveInitial!: (settings: AppSettings) => void;
    const initial = new Promise<AppSettings>((resolve) => {
      resolveInitial = resolve;
    });
    const source = {
      onChanged(listener: (settings: AppSettings) => void) {
        calls.push("subscribe");
        changedListener = listener;
        return () => calls.push("unsubscribe");
      },
      get() {
        calls.push("get");
        return initial;
      },
    };

    const dispose = subscribeToSettingsWithInitialLoad(
      source,
      (settings) => applied.push(settings),
      (error) => errors.push(error),
    );
    expect(calls).toEqual(["subscribe", "get"]);

    const pushed = { ...DEFAULT_SETTINGS, language: "German" };
    changedListener(pushed);
    resolveInitial({ ...DEFAULT_SETTINGS, language: "French" });
    await initial;
    await Promise.resolve();

    expect(applied).toEqual([pushed]);
    expect(errors).toEqual([]);
    dispose();
    expect(calls).toEqual(["subscribe", "get", "unsubscribe"]);

    changedListener({ ...DEFAULT_SETTINGS, language: "Spanish" });
    expect(applied).toEqual([pushed]);
  });

  it("applies the initial snapshot when no settings change wins the race", async () => {
    const initial = { ...DEFAULT_SETTINGS, language: "French" };
    const applied: AppSettings[] = [];
    subscribeToSettingsWithInitialLoad(
      {
        onChanged: () => () => undefined,
        get: async () => initial,
      },
      (settings) => applied.push(settings),
      () => undefined,
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toEqual([initial]);
  });
});

/*
 * Every unavailable-hold branch of this copy recommended the toggle shortcut.
 * That advice is worse than nothing on a Mac where another app already owns the
 * accelerator: registration fails silently at startup, so the user is told to
 * press a key that does nothing, with no other surface reporting why. These
 * tests pin that the recommendation is withdrawn exactly when it is untrue.
 */
describe("push-to-talk help text when the toggle shortcut is not registered", () => {
  const dead = { ready: false } as const;
  const live = { ready: true } as const;

  it("stops recommending the toggle when Accessibility is the blocker", () => {
    const permissions = {
      platform: "darwin",
      globalHold: { ready: false },
      accessibility: { granted: false },
    } as const;

    expect(shortcutHelpText({ ...permissions, globalToggle: live } as never, "Control")).toBe(
      "The current push-to-talk key is Control. Grant Accessibility to use it globally; until then, use the toggle shortcut and LocalScribe will copy completed dictation.",
    );

    const withDeadToggle = shortcutHelpText(
      { ...permissions, globalToggle: dead } as never,
      "Control",
    );
    expect(withDeadToggle).toBe(
      "The current push-to-talk key is Control. Grant Accessibility to use it globally."
      + ` ${TOGGLE_UNREGISTERED_ADVICE}`,
    );
    // The wrong instruction is gone, not merely accompanied by a correction.
    expect(withDeadToggle).not.toMatch(/use the toggle shortcut/u);
  });

  it("stops recommending the toggle when the hook is dead despite Accessibility", () => {
    const permissions = {
      platform: "darwin",
      globalHold: { ready: false },
      accessibility: { granted: true },
    } as const;

    expect(shortcutHelpText({ ...permissions, globalToggle: live } as never, "Control")).toMatch(
      /Restart LocalScribe or use the toggle shortcut\.$/u,
    );
    const withDeadToggle = shortcutHelpText(
      { ...permissions, globalToggle: dead } as never,
      "Control",
    );
    expect(withDeadToggle).not.toMatch(/toggle shortcut\./u);
    expect(withDeadToggle).toContain(TOGGLE_UNREGISTERED_ADVICE);
    // The remaining diagnosis is still shown; only the bad advice is replaced.
    expect(withDeadToggle).toContain("the global keyboard hook is not running");
  });

  it("still reports the dead toggle when push-to-talk works", () => {
    const permissions = {
      platform: "darwin",
      globalHold: { ready: true },
      accessibility: { granted: true },
    } as const;

    expect(shortcutHelpText({ ...permissions, globalToggle: live } as never, "Control")).toBe(
      "Shortcut changes apply immediately. Hold Control to dictate from any app.",
    );
    // Hold covers dictation, but both menus still display the toggle
    // accelerator, so its failure has to be reported somewhere.
    expect(shortcutHelpText({ ...permissions, globalToggle: dead } as never, "Control")).toBe(
      "Shortcut changes apply immediately. Hold Control to dictate from any app."
      + ` ${TOGGLE_UNREGISTERED_ADVICE}`,
    );
  });

  it("names an action the user can take rather than only reporting a failure", () => {
    expect(TOGGLE_UNREGISTERED_ADVICE).toMatch(/Choose a different toggle shortcut/u);
    expect(TOGGLE_UNREGISTERED_ADVICE).toMatch(/menu bar icon/u);
    // No path, PID, app name, or accelerator of the conflicting app: main does
    // not know it, and guessing would be a privacy leak as well as wrong.
    expect(TOGGLE_UNREGISTERED_ADVICE).not.toMatch(/\/|\\|\.app\b/u);
  });

  it("leaves the unknown-permissions text alone", () => {
    expect(shortcutHelpText(null, "Control")).toBe(
      "Shortcut changes apply immediately. The current push-to-talk key is Control.",
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

  it("limits language choices to the selected model capabilities and names Parakeet automatic English honestly", () => {
    const parakeet = dictationLanguagePresentation("auto", {
      languageDetection: false,
      supportedLanguages: ["en"],
    });
    expect(parakeet).toMatchObject({
      enabled: true,
      detail: "The selected local model supports English only. “Automatic” uses that language; it does not detect language.",
      options: [
        { value: "auto", label: "English (automatic)" },
        { value: "English", label: "English" },
      ],
    });
    expect(parakeet.options.map((option) => option.value)).not.toContain("Spanish");

    const inheritedSpanish = dictationLanguagePresentation("Spanish", {
      languageDetection: false,
      supportedLanguages: ["en"],
    });
    expect(inheritedSpanish.options[0]).toEqual({
      value: "Spanish",
      label: "Spanish (saved; unsupported by selected model)",
      disabled: true,
    });
    expect(inheritedSpanish.detail).toContain("choose a supported language before dictating");
  });

  it("holds the language selector until model capability status is available", () => {
    expect(dictationLanguagePresentation("auto", null)).toMatchObject({
      enabled: false,
      detail: "Loading language support for the selected local model. Choose a language after model status is ready.",
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

  it("does not claim enabled when macOS externally disabled the startup item", () => {
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

  it("uses macOS unified-memory language", () => {
    expect(modelMemoryCopy()).toEqual({
      summary: "Auto uses available unified memory to choose the highest profile that fits in the active family.",
      memoryLabel: "Unified memory",
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

  it("calls a runtime resident only when exact saved family, profile, artifact, and mode resolve", () => {
    const settings = {
      activeModelFamilyId: "whisper-large-v3",
      modelPerformanceMode: "medium",
    } as const;
    const diagnostics = {
      model: {
        loaded: true,
        familyId: "whisper-large-v3",
        profileId: "v3-medium",
        artifactId: "v3-medium-artifact",
      },
      performance: { preference: "medium", resolvedTier: "medium" },
    };
    const catalog = {
      families: [{
        familyId: "whisper-large-v3",
        profiles: [{ tier: "medium", profileId: "v3-medium", artifactId: "v3-medium-artifact" }],
      }],
    };

    expect(residentModelMatchesSavedSelection(settings, diagnostics as never, catalog as never)).toBe(true);
    expect(residentModelMatchesSavedSelection(settings, {
      ...diagnostics,
      model: { ...diagnostics.model, artifactId: "different-artifact" },
    } as never, catalog as never)).toBe(false);
    expect(residentModelMatchesSavedSelection(settings, {
      ...diagnostics,
      model: { ...diagnostics.model, loaded: false },
    } as never, catalog as never)).toBe(false);
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

describe("model operation status", () => {
  it("accepts measured transfer updates only for the in-flight profile", () => {
    const active = {
      action: "installing" as const,
      familyId: "whisper-large-v3" as const,
      tier: "medium" as const,
      progress: { phase: "preparing" as const },
    };
    const progress = {
      familyId: "whisper-large-v3" as const,
      tier: "medium" as const,
      artifactId: "whisper-large-v3-medium",
      phase: "verifying" as const,
      completedBytes: 300,
      totalBytes: 600,
    };

    expect(modelActionWithInstallProgress(active, progress)).toMatchObject({
      action: "installing",
      progress: { phase: "verifying", completedBytes: 300, totalBytes: 600 },
    });
    expect(modelActionWithInstallProgress(active, { ...progress, tier: "high" })).toBe(active);
    expect(modelActionWithInstallProgress({
      action: "removing",
      familyId: "whisper-large-v3",
      tier: "medium",
    }, progress)).toMatchObject({ action: "removing" });
  });

  it("confirms the exact loaded artifact and resolved mode returned by Apply", () => {
    expect(appliedModelSelectionMessage({
      families: [{ familyId: "whisper-large-v3", displayName: "Whisper large-v3" }],
    } as never, {
      familyId: "whisper-large-v3",
      artifactId: "whisper-large-v3-medium",
      tier: "medium",
      asrMode: "after-stop",
    })).toBe("Whisper large-v3 · Medium · After I stop is applied, loaded, and ready.");
  });
});

/*
 * `modelAction` disables the library buttons, but only from the render that
 * carries it. Two dispatches in the same tick — a double click, or a click plus
 * a keyboard activation — both see a null action and both run; whichever
 * settles first clears `modelAction` and re-enables every button while the
 * other is still downloading, and "Add to library" was reachable during an
 * in-flight install. Each entry point takes a synchronous latch instead.
 */
describe("model-library actions are mutually exclusive before the next render", () => {
  const source = readFileSync("src/renderer/settings/screens/StyleSettings.tsx", "utf8");

  function body(name: string): string {
    const start = requireIndex(source, `const ${name} = async (`, name);
    // Unguarded, `indexOf` here returns -1 if the closing formatting ever
    // changes, and `slice(start, -1)` then swallows most of the file — every
    // `toContain` below would start matching unrelated handlers.
    const end = source.indexOf("\n  };", start);
    expect(end, `${name} handler is not closed as expected`).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it.each(["installModel", "removeModel", "addModelFamily"])(
    "%s refuses to start while another library action is in flight",
    (name) => {
      const handler = body(name);
      expect(handler).toContain("if (modelOperationInFlight.current) return;");
      expect(handler).toContain("modelOperationInFlight.current = true;");
      expect(handler).toContain("modelOperationInFlight.current = false;");

      // The latch has to be taken before the first await, or the second
      // dispatch runs before it is set and the guard proves nothing.
      const latch = handler.indexOf("modelOperationInFlight.current = true;");
      const firstAwait = handler.indexOf("await ");
      expect(latch).toBeGreaterThan(0);
      expect(latch).toBeLessThan(firstAwait);

      // And released in `finally`, so a rejected download does not wedge the
      // whole model library until the window is reopened.
      const release = handler.indexOf("modelOperationInFlight.current = false;");
      expect(handler.slice(0, release)).toContain("} finally {");
    },
  );

  /*
   * This assertion used to be `indexOf("window.confirm") < indexOf(latch)`,
   * which passes when the confirmation is *absent*: `indexOf` returns -1 and
   * -1 is less than any real index. It was the only test anywhere pinning that
   * a destructive model removal asks first, and deleting the prompt entirely
   * left it green. `expectPrecedes` requires both markers to exist.
   */
  it("asks for confirmation before taking the latch, so cancelling leaves the library usable", () => {
    for (const name of ["installModel", "removeModel"]) {
      expectPrecedes(
        body(name),
        "window.confirm",
        "modelOperationInFlight.current = true;",
        name,
      );
    }
  });

  it("confirms the destructive action itself, not merely something", () => {
    // Naming the prompt text pins that the confirmation covers the removal
    // rather than being an unrelated dialog that happens to appear earlier.
    expect(body("removeModel")).toContain("from this computer?");
    expect(body("installModel")).toContain("of curated model data.");
  });
});
