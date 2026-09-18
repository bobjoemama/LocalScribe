/**
 * Renderer fixture for test-settings-scroll-layout.mjs.
 *
 * It bundles the real SettingsModal into Chromium with deterministic IPC
 * responses. This is deliberately separate from product runtime code.
 */
import { createRoot } from "react-dom/client";
import {
  DEFAULT_SETTINGS,
  appSettingsSchema,
  type AppSettings,
  type AppSettingsPatch,
  type Diagnostics,
  type LaunchAtLoginStatus,
  type LocalScribeApi,
  type ModelCatalog,
  type ModelCapabilities,
  type ModelSelectionApplyRequest,
  type PermissionSnapshot,
} from "../src/shared/contracts";
import { SettingsModal } from "../src/renderer/settings/screens/StyleSettings";
import "../src/renderer/styles.css";

const GIBIBYTE = 1_073_741_824;
const harnessParams = new URLSearchParams(window.location.search);
const harnessPlatform = "darwin" as const;
const harnessVerification = (
  ["missing", "invalid", "verified"].includes(harnessParams.get("verification") ?? "")
    ? harnessParams.get("verification")
    : "missing"
) as "missing" | "invalid" | "verified";
const harnessSettingsPreset = harnessParams.get("settings") === "custom" ? "custom" : "default";
const harnessApplyResult = harnessParams.get("apply") === "fail" ? "fail" : "success";
/*
 * `save=fail` makes settings.patch reject with the longest message the product
 * can actually show. rendererSafeErrorMessage caps the detail at 160 characters
 * and StyleSettings prefixes "Could not save settings: ", so 185 characters is
 * the real worst case for the footer status. The harness reproduces that exact
 * string so the layout gate measures the widest status a user can hit.
 */
const harnessSaveFails = harnessParams.get("save") === "fail";
const LONGEST_SAVE_FAILURE_DETAIL = "The local settings store rejected this change and kept the previous values, "
  + "so nothing was modified; close this window and try saving again once the machine is idle and "
  + "no other copy of the application is running.";
const usesCustomSettings = harnessSettingsPreset === "custom";
Object.defineProperty(navigator, "platform", {
  configurable: true,
  value: "MacIntel",
});
const modelPresent = harnessVerification !== "missing";
const modelVerified = harnessVerification === "verified";
const backend = "MLX Audio";
const qwenArtifactPrecisions = ["bf16", "8bit", "4bit"] as const;
const qwenArtifactIds = qwenArtifactPrecisions.map(
  (precision) => `qwen3-asr-1-7b-mlx-${precision}`,
);
const qwenArtifacts = qwenArtifactIds.map((artifactId, index) => ({
  artifactId,
  displayName: `Qwen3-ASR 1.7B · MLX ${qwenArtifactPrecisions[index]}`,
  backend: "MLX Audio",
  modelId: `curated/qwen3-asr-1-7b-${qwenArtifactPrecisions[index]}`,
  storageDirectory: artifactId,
  revision: `${index + 4}`.repeat(40),
  license: "Apache-2.0",
  expectedDownloadBytes: [4_080_710_353, 2_467_859_030, 1_607_633_106][index]!,
}));
const qwen06ArtifactIds = qwenArtifactPrecisions.map(
  (precision) => `qwen3-asr-0-6b-mlx-${precision}`,
);
const qwen06Artifacts = qwen06ArtifactIds.map((artifactId, index) => ({
  artifactId,
  displayName: `Qwen3-ASR 0.6B · MLX ${qwenArtifactPrecisions[index]}`,
  backend: "MLX Audio",
  modelId: `mlx-community/Qwen3-ASR-0.6B-${qwenArtifactPrecisions[index]}`,
  storageDirectory: artifactId,
  revision: `${index + 7}`.repeat(40),
  license: "Apache-2.0",
  expectedDownloadBytes: [1_569_438_434, 1_010_773_761, 712_781_279][index]!,
}));
const activeArtifactIds = qwen06ArtifactIds;
const activeArtifacts = qwen06Artifacts;
const canaryPrecisions = ["bf16", "q8", "q4"] as const;
const canaryArtifacts = canaryPrecisions.map((precision, index) => ({
  artifactId: `canary-qwen-2-5b-gguf-${precision}`,
  displayName: `Canary-Qwen 2.5B · GGUF ${precision}`,
  backend: "transcribe.cpp / Metal",
  modelId: "handy-computer/canary-qwen-2.5b-gguf",
  storageDirectory: `canary-qwen-2-5b-${precision}`,
  revision: "3370d4e2f28cc70eea79dfc9f2f43fb91eef3163",
  license: "CC-BY-4.0",
  expectedDownloadBytes: [5_076_107_136, 2_797_548_928, 1_737_575_808][index]!,
}));
const parakeetArtifactIds = [
  "parakeet-unified-en-0-6b-coreml-fp16",
  "parakeet-unified-en-0-6b-coreml-int8",
] as const;
const parakeetArtifacts = parakeetArtifactIds.map((artifactId, index) => ({
  artifactId,
  displayName: "Parakeet Unified EN 0.6B · CoreML / ANE",
  backend: "FluidAudio CoreML / ANE",
  modelId: "FluidInference/parakeet-unified-en-0.6b-coreml",
  storageDirectory: artifactId,
  revision: "4252711f6f060f9a2f91e5f081a806d7f45eebd8",
  license: "CC-BY-4.0",
  expectedDownloadBytes: [2_383_019_889, 1_204_996_845][index]!,
}));

let persistedSettings: AppSettings = appSettingsSchema.parse(usesCustomSettings
  ? {
      ...DEFAULT_SETTINGS,
      launchAtLogin: true,
      showPillWhenIdle: false,
      autoPaste: false,
      keepHistory: false,
      language: "Italian",
      microphoneId: "disconnected-usb-microphone",
      activeModelFamilyId: "qwen3-asr-0-6b",
      modelLibraryFamilyIds: ["qwen3-asr-0-6b"],
      modelPerformanceMode: "low",
      historyRetentionDays: 90,
      removeFillers: false,
      spokenCommands: true,
      smartPunctuation: false,
      holdShortcut: "Alt+F13",
      toggleShortcut: "CommandOrControl+F14",
    }
  : DEFAULT_SETTINGS);
if (harnessParams.has("apply")) {
  persistedSettings = appSettingsSchema.parse({
    ...persistedSettings,
    // The Apply scenario begins with the exact verified Qwen 0.6B runtime in
    // the diagnostics fixture, then proves a staged switch to Qwen 1.7B. Keep the
    // saved selection and resident runtime coherent before the click.
    activeModelFamilyId: "qwen3-asr-0-6b",
    asrMode: "after-stop",
    modelPerformanceMode: "high",
    modelLibraryFamilyIds: [
      "qwen3-asr-0-6b",
      "qwen3-asr-1-7b",
    ],
  });
}
const settingsPatchCalls: AppSettingsPatch[] = [];
let permissionPollCount = 0;
const windowVisibilityListeners = new Set<(visible: boolean) => void>();
const modelApplyCalls: ModelSelectionApplyRequest[] = [];
const settingsListeners = new Set<(settings: AppSettings) => void>();
let launchAtLoginStatus: LaunchAtLoginStatus = usesCustomSettings
  ? {
      supported: true,
      registered: true,
      effective: false,
      requiresApproval: true,
      status: "requires-approval",
    }
  : {
      supported: true,
      registered: false,
      effective: false,
      requiresApproval: false,
      status: "not-registered",
    };

const fakeMicrophones = [{
  deviceId: "built-in-microphone",
  groupId: "built-in",
  kind: "audioinput",
  label: "MacBook Pro Microphone",
  toJSON: () => ({}),
}] as MediaDeviceInfo[];
Object.defineProperty(navigator, "mediaDevices", {
  configurable: true,
  value: {
    enumerateDevices: async () => fakeMicrophones,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as MediaDevices,
});

const permissions: PermissionSnapshot = {
  platform: harnessPlatform,
  microphone: "granted",
  microphoneSettingsAvailable: true,
  accessibility: { supported: true, granted: true },
  automaticPaste: { supported: true, ready: true },
  globalHold: { supported: true, ready: true },
  globalToggle: { supported: true, ready: true },
};

const afterStopCapabilities: ModelCapabilities = {
  modes: ["after-stop"],
  partialResults: false,
  timestamps: false,
  languageDetection: true,
  promptContext: true,
  keywordBoost: false,
  supportedLanguages: ["auto", "en", "es", "fr", "de", "hi"],
};
const parakeetCapabilities: ModelCapabilities = {
  modes: ["after-stop", "live"],
  partialResults: true,
  timestamps: false,
  languageDetection: false,
  promptContext: false,
  keywordBoost: false,
  supportedLanguages: ["en"],
};

const catalog: ModelCatalog = {
  platform: "darwin-arm64",
  activeModelFamilyId: "qwen3-asr-0-6b",
  recommendedDefaultFamilyId: "parakeet-unified-en-0-6b",
  modelLibraryFamilyIds: harnessParams.has("apply")
    ? ["qwen3-asr-0-6b", "qwen3-asr-1-7b"]
    : ["qwen3-asr-0-6b"],
  families: [
    ...[{
      familyId: "parakeet-unified-en-0-6b" as const,
      displayName: "Parakeet Unified EN 0.6B",
      capabilities: parakeetCapabilities,
      recommendedDefault: true,
      active: false,
      inLibrary: false,
      artifacts: parakeetArtifacts,
      profiles: (["high", "medium"] as const).map((tier, index) => ({
        profileId: `parakeet-unified-en-0-6b-${tier}`,
        tier,
        artifactId: parakeetArtifactIds[index]!,
        engine: "fluid-audio" as const,
        precision: (["coreml-fp16", "coreml-int8"] as const)[index]!,
        expectedMemoryMinBytes: [0.8, 0.6][index]! * GIBIBYTE,
        expectedMemoryMaxBytes: [1.3, 1.1][index]! * GIBIBYTE,
        memoryBasis: "estimated" as const,
      })),
    }],
    {
      familyId: "qwen3-asr-0-6b",
      displayName: "Qwen3-ASR 0.6B",
      capabilities: afterStopCapabilities,
      recommendedDefault: false,
      active: true,
      inLibrary: true,
      artifacts: qwen06Artifacts,
      profiles: ["high", "medium", "low"].map((tier, index) => ({
        profileId: `qwen3-asr-0-6b-${tier}`,
        tier: tier as "high" | "medium" | "low",
        artifactId: qwen06ArtifactIds[index]!,
        engine: "mlx-audio" as const,
        precision: (["bf16", "8-bit", "4-bit"] as const)[index]!,
        expectedMemoryMinBytes: [2, 1.4, 1.1][index]! * GIBIBYTE,
        expectedMemoryMaxBytes: [3, 2.3, 2][index]! * GIBIBYTE,
        memoryBasis: "estimated" as const,
      })),
    },
    {
      familyId: "qwen3-asr-1-7b",
      displayName: "Qwen3-ASR 1.7B",
      capabilities: afterStopCapabilities,
      recommendedDefault: false,
      active: false,
      inLibrary: harnessParams.has("apply"),
      artifacts: qwenArtifacts,
      profiles: ["high", "medium", "low"].map((tier, index) => ({
        profileId: `qwen3-asr-1-7b-${tier}`,
        tier: tier as "high" | "medium" | "low",
        artifactId: qwenArtifactIds[index]!,
        engine: "mlx-audio" as const,
        precision: (["bf16", "8-bit", "4-bit"] as const)[index]!,
        expectedMemoryMinBytes: [4.2, 2.6, 1.8][index]! * GIBIBYTE,
        expectedMemoryMaxBytes: [5.4, 3.6, 2.8][index]! * GIBIBYTE,
        memoryBasis: "estimated" as const,
      })),
    },
    {
      familyId: "canary-qwen-2-5b",
      displayName: "Canary-Qwen 2.5B",
      capabilities: { ...afterStopCapabilities, languageDetection: false, promptContext: false, supportedLanguages: ["en"] },
      recommendedDefault: false,
      active: false,
      inLibrary: false,
      artifacts: canaryArtifacts,
      profiles: ["high", "medium", "low"].map((tier, index) => ({
        profileId: `canary-qwen-2-5b-${tier}`,
        tier: tier as "high" | "medium" | "low",
        artifactId: canaryArtifacts[index]!.artifactId,
        engine: "transcribe-cpp" as const,
        precision: (["bf16", "8-bit", "4-bit"] as const)[index]!,
        expectedMemoryMinBytes: [6, 4, 3][index]! * GIBIBYTE,
        expectedMemoryMaxBytes: [9, 7, 6][index]! * GIBIBYTE,
        memoryBasis: "estimated" as const,
      })),
    },
  ],
  verifications: [
    ...parakeetArtifacts.map((artifact) => ({
      familyId: "parakeet-unified-en-0-6b" as const,
      artifactId: artifact.artifactId,
      present: false,
      verified: false,
      verificationStatus: "missing" as const,
      sizeBytes: 0,
      expectedBytes: artifact.expectedDownloadBytes,
      verifiedFiles: 0,
      expectedFiles: 18,
    })),
    ...activeArtifacts.map((artifact) => ({
      familyId: "qwen3-asr-0-6b" as const,
      artifactId: artifact.artifactId,
      present: modelPresent,
      verified: modelVerified,
      verificationStatus: harnessVerification,
      sizeBytes: modelPresent ? artifact.expectedDownloadBytes : 0,
      expectedBytes: artifact.expectedDownloadBytes,
      verifiedFiles: modelVerified ? 1 : 0,
      expectedFiles: 1,
    })),
    ...qwenArtifacts.map((artifact) => ({
      familyId: "qwen3-asr-1-7b" as const,
      artifactId: artifact.artifactId,
      present: harnessParams.has("apply"),
      verified: harnessParams.has("apply"),
      verificationStatus: harnessParams.has("apply") ? "verified" as const : "missing" as const,
      sizeBytes: harnessParams.has("apply") ? artifact.expectedDownloadBytes : 0,
      expectedBytes: artifact.expectedDownloadBytes,
      verifiedFiles: harnessParams.has("apply") ? 1 : 0,
      expectedFiles: 1,
    })),
    ...canaryArtifacts.map((artifact) => ({
      familyId: "canary-qwen-2-5b" as const,
      artifactId: artifact.artifactId,
      present: false,
      verified: false,
      verificationStatus: "missing" as const,
      sizeBytes: 0,
      expectedBytes: artifact.expectedDownloadBytes,
      verifiedFiles: 0,
      expectedFiles: 1,
    })),
  ],
  unmanagedEntries: [],
};

const diagnostics: Diagnostics = {
  platform: harnessPlatform,
  architecture: "arm64",
  backend,
  databaseIntegrity: "ok",
  /*
   * Added when `scripts/` joined the typecheck: the contract has carried this
   * field since unreadable history rows became countable, and the harness
   * fixture had silently drifted behind it.
   */
  unreadableRecords: 0,
  model: {
    familyId: "qwen3-asr-0-6b",
    artifactId: activeArtifactIds[0]!,
    profileId: "qwen3-asr-0-6b-high",
    displayName: "Qwen3-ASR 0.6B High",
    modelId: activeArtifacts[0]!.modelId,
    storageDirectory: activeArtifacts[0]!.storageDirectory,
    installed: modelVerified,
    // Both Apply scenarios begin with a warm verified model. Success switches
    // it; failure must leave this exact prior runtime active.
    loaded: harnessParams.has("apply"),
    present: modelPresent,
    verified: modelVerified,
    verificationStatus: harnessVerification,
    sizeBytes: modelPresent ? activeArtifacts[0]!.expectedDownloadBytes : 0,
    expectedBytes: activeArtifacts[0]!.expectedDownloadBytes,
    verifiedFiles: modelVerified ? 1 : 0,
    expectedFiles: 1,
    revision: activeArtifacts[0]!.revision,
    license: activeArtifacts[0]!.license,
  },
  accelerator: {
    kind: "apple-unified",
    displayName: "Apple M-series GPU",
    totalMemoryBytes: 48 * GIBIBYTE,
    freeMemoryBytes: 30 * GIBIBYTE,
    memoryBasis: "measured",
  },
  performance: {
    preference: persistedSettings.modelPerformanceMode,
    resolvedTier: usesCustomSettings ? "low" : "high",
    fitsMemoryBudget: true,
    resolutionReason: usesCustomSettings
      ? "Low is the saved explicit profile for this Mac."
      : "High fits the currently reported unified memory.",
    reservedHeadroomBytes: 2 * GIBIBYTE,
    requiredFreeMemoryBytes: 12 * GIBIBYTE,
    options: ["high", "medium", "low"].map((tier, index) => ({
      tier: tier as "high" | "medium" | "low",
      modelKey: tier,
      profileId: `qwen3-asr-0-6b-${tier}`,
      artifactId: activeArtifactIds[index]!,
      displayName: `Qwen3-ASR 0.6B ${tier}`,
      engine: backend,
      precision: (["bf16", "8-bit", "4-bit"] as const)[index]!,
      expectedMemoryMinBytes: [2, 1.4, 1.1][index]! * GIBIBYTE,
      expectedMemoryMaxBytes: [3, 2.3, 2][index]! * GIBIBYTE,
      memoryBasis: "estimated" as const,
      expectedDownloadBytes: activeArtifacts[index]!.expectedDownloadBytes,
      qualityNote: "Curated local speech profile.",
      verificationStatus: harnessVerification,
      installed: modelVerified,
      present: modelPresent,
      verified: modelVerified,
    })),
  },
  dataPath: "/tmp/localscribe-layout-harness",
};

window.localScribe = {
  settings: {
    get: async () => appSettingsSchema.parse(persistedSettings),
    patch: async (patch: AppSettingsPatch) => {
      settingsPatchCalls.push({ ...patch });
      if (harnessSaveFails) throw new Error(LONGEST_SAVE_FAILURE_DETAIL);
      persistedSettings = appSettingsSchema.parse({ ...persistedSettings, ...patch });
      if (patch.launchAtLogin !== undefined) {
        launchAtLoginStatus = {
          supported: true,
          registered: patch.launchAtLogin,
          effective: patch.launchAtLogin,
          requiresApproval: false,
          status: patch.launchAtLogin ? "enabled" : "not-registered",
        };
      }
      for (const listener of settingsListeners) listener(persistedSettings);
      return appSettingsSchema.parse(persistedSettings);
    },
    onChanged: (listener: (settings: AppSettings) => void) => {
      settingsListeners.add(listener);
      return () => settingsListeners.delete(listener);
    },
  },
  profiles: {
    list: async () => usesCustomSettings ? [{
      id: "11111111-1111-4111-8111-111111111111",
      appId: "com.apple.TextEdit",
      label: "TextEdit",
      removeFillers: false,
      spokenCommands: true,
      smartPunctuation: false,
      createdAt: 1,
    }] : [],
  },
  system: {
    getPermissions: async () => {
      permissionPollCount += 1;
      return permissions;
    },
    getLaunchAtLoginStatus: async () => ({ ...launchAtLoginStatus }),
    diagnostics: async () => diagnostics,
    modelCatalog: async () => catalog,
    openPermission: async () => undefined,
    addModelFamily: async () => catalog,
    applyModelSelection: async (request: ModelSelectionApplyRequest) => {
      modelApplyCalls.push({ ...request });
      if (harnessApplyResult === "fail") throw new Error("Harness model load failed");
      persistedSettings = appSettingsSchema.parse({
        ...persistedSettings,
        asrMode: request.asrMode,
        activeModelFamilyId: request.familyId,
        modelPerformanceMode: request.performanceMode,
      });
      for (const listener of settingsListeners) listener(persistedSettings);
      const appliedCatalog: ModelCatalog = {
        ...catalog,
        activeModelFamilyId: request.familyId,
        modelLibraryFamilyIds: [...new Set([...catalog.modelLibraryFamilyIds, request.familyId])],
        families: catalog.families.map((candidate) => ({
          ...candidate,
          active: candidate.familyId === request.familyId,
          inLibrary: candidate.inLibrary || candidate.familyId === request.familyId,
        })),
      };
      const family = appliedCatalog.families.find((candidate) => candidate.familyId === request.familyId);
      const appliedTier = request.performanceMode === "auto" ? "medium" : request.performanceMode;
      const profile = family?.profiles.find((candidate) => candidate.tier === appliedTier)
        ?? family?.profiles[0];
      const artifact = family?.artifacts.find((candidate) => candidate.artifactId === profile?.artifactId);
      if (!family || !profile || !artifact) throw new Error("Harness applied model is missing catalog data");
      return {
        applied: true as const,
        appliedSelection: {
          familyId: request.familyId,
          artifactId: profile.artifactId,
          tier: profile.tier,
          asrMode: request.asrMode,
        },
        settings: persistedSettings,
        catalog: appliedCatalog,
        diagnostics: {
          ...diagnostics,
          model: {
            ...diagnostics.model,
            familyId: family.familyId,
            artifactId: profile.artifactId,
            profileId: profile.profileId,
            displayName: `${family.displayName} ${profile.tier}`,
            modelId: artifact.modelId,
            storageDirectory: artifact.storageDirectory,
            installed: true,
            loaded: true,
            present: true,
            verified: true,
            verificationStatus: "verified" as const,
            sizeBytes: artifact.expectedDownloadBytes,
            expectedBytes: artifact.expectedDownloadBytes,
            verifiedFiles: 1,
            expectedFiles: 1,
            revision: artifact.revision,
            license: artifact.license,
          },
          performance: {
            ...diagnostics.performance,
            preference: request.performanceMode,
            resolvedTier: request.performanceMode === "auto" ? diagnostics.performance.resolvedTier : request.performanceMode,
            options: family.profiles.map((candidate, index) => {
              const candidateArtifact = family.artifacts.find((entry) => (
                entry.artifactId === candidate.artifactId
              ));
              if (!candidateArtifact) throw new Error("Harness model profile has no artifact");
              return {
                ...diagnostics.performance.options[index % diagnostics.performance.options.length]!,
                tier: candidate.tier,
                modelKey: candidate.profileId,
                profileId: candidate.profileId,
                artifactId: candidate.artifactId,
                displayName: `${family.displayName} ${candidate.tier}`,
                engine: candidate.engine,
                precision: candidate.precision,
                expectedMemoryMinBytes: candidate.expectedMemoryMinBytes,
                expectedMemoryMaxBytes: candidate.expectedMemoryMaxBytes,
                memoryBasis: candidate.memoryBasis,
                expectedDownloadBytes: candidateArtifact.expectedDownloadBytes,
                verificationStatus: "verified" as const,
                installed: true,
                present: true,
                verified: true,
              };
            }),
          },
        },
      };
    },
    installModel: async () => diagnostics,
    onModelInstallProgress: () => () => undefined,
    removeModel: async () => diagnostics,
  },
  windows: {
    /*
     * Main pushes native window visibility because the renderer cannot derive
     * it: backgroundThrottling: false pins document.visibilityState to
     * "visible". The harness stands in for main so the gate can prove the
     * permission poll actually stops when the window is hidden.
     */
    onVisibilityChanged: (listener: (visible: boolean) => void) => {
      windowVisibilityListeners.add(listener);
      return () => windowVisibilityListeners.delete(listener);
    },
  },
} as unknown as LocalScribeApi;

const root = createRoot(document.getElementById("root")!);
let renderSequence = 0;
const renderSettings = () => {
  renderSequence += 1;
  root.render(<SettingsModal key={renderSequence} onClose={() => undefined} />);
};
(window as unknown as {
  __localScribeSettingsHarness: {
    patchCalls: AppSettingsPatch[];
    applyCalls: ModelSelectionApplyRequest[];
    persisted(): AppSettings;
    remount(): void;
    permissionPolls(): number;
    setWindowVisible(visible: boolean): void;
  };
}).__localScribeSettingsHarness = {
  patchCalls: settingsPatchCalls,
  applyCalls: modelApplyCalls,
  permissionPolls: () => permissionPollCount,
  setWindowVisible: (visible: boolean) => {
    for (const listener of windowVisibilityListeners) listener(visible);
  },
  persisted: () => persistedSettings,
  remount: renderSettings,
};
renderSettings();
