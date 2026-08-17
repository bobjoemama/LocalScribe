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
const harnessPlatform = harnessParams.get("platform") === "win32" ? "win32" : "darwin";
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
const isWindows = harnessPlatform === "win32";
const usesCustomSettings = harnessSettingsPreset === "custom";
Object.defineProperty(navigator, "platform", {
  configurable: true,
  value: isWindows ? "Win32" : "MacIntel",
});
const modelPresent = harnessVerification !== "missing";
const modelVerified = harnessVerification === "verified";
const engine = isWindows ? "faster-whisper" as const : "mlx-whisper" as const;
const backend = isWindows ? "faster-whisper/CTranslate2" : "MLX Whisper";
const activeArtifactIds = isWindows
  ? ["whisper-large-v3-ctranslate2"]
  : ["whisper-large-v3-high", "whisper-large-v3-medium", "whisper-large-v3-low"];
const activeArtifacts = activeArtifactIds.map((artifactId, index) => ({
  artifactId,
  displayName: isWindows ? "Whisper large-v3 CTranslate2 model data" : `Whisper large-v3 ${["high", "medium", "low"][index]}`,
  backend,
  modelId: isWindows ? "curated/whisper-large-v3-ctranslate2" : `curated/whisper-large-v3-${["high", "medium", "low"][index]}`,
  storageDirectory: isWindows ? "whisper-large-v3-ctranslate2" : `whisper-large-v3-${["high", "medium", "low"][index]}`,
  revision: `${index + 1}`.repeat(40),
  license: "MIT",
  expectedDownloadBytes: isWindows ? 3_100_000_000 : (3 - index) * 1_000_000_000,
}));
const qwenArtifactPrecisions = isWindows
  ? (["f16", "q8-0", "q4-k"] as const)
  : (["bf16", "8bit", "4bit"] as const);
const qwenArtifactIds = qwenArtifactPrecisions.map(
  (precision) => `qwen3-asr-1-7b-${isWindows ? "crisp" : "mlx"}-${precision}`,
);
const qwenArtifacts = qwenArtifactIds.map((artifactId, index) => ({
  artifactId,
  displayName: `Qwen3-ASR 1.7B · ${isWindows ? "CrispASR" : "MLX"} ${qwenArtifactPrecisions[index]}`,
  backend: isWindows ? "CrispASR CUDA" : "MLX Audio",
  modelId: `curated/qwen3-asr-1-7b-${qwenArtifactPrecisions[index]}`,
  storageDirectory: artifactId,
  revision: `${index + 4}`.repeat(40),
  license: "Apache-2.0",
  expectedDownloadBytes: isWindows
    ? [4_704_800_576, 2_506_723_200, 1_490_915_200][index]!
    : [4_080_710_353, 2_467_859_030, 1_607_633_106][index]!,
}));
const qwen06ArtifactIds = qwenArtifactPrecisions.map(
  (precision) => `qwen3-asr-0-6b-${isWindows ? "crisp" : "mlx"}-${precision}`,
);
const qwen06Artifacts = qwen06ArtifactIds.map((artifactId, index) => ({
  artifactId,
  displayName: `Qwen3-ASR 0.6B · ${isWindows ? "CrispASR" : "MLX"} ${qwenArtifactPrecisions[index]}`,
  backend: isWindows ? "CrispASR CUDA" : "MLX Audio",
  modelId: isWindows
    ? "cstr/qwen3-asr-0.6b-GGUF"
    : `mlx-community/Qwen3-ASR-0.6B-${qwenArtifactPrecisions[index]}`,
  storageDirectory: artifactId,
  revision: `${index + 7}`.repeat(40),
  license: "Apache-2.0",
  expectedDownloadBytes: isWindows
    ? [1_882_037_824, 1_006_809_760, 631_026_336][index]!
    : [1_569_438_434, 1_010_773_761, 712_781_279][index]!,
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
    modelLibraryFamilyIds: ["whisper-large-v3", "qwen3-asr-1-7b"],
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
      requiresApproval: !isWindows,
      status: isWindows ? "disabled" : "requires-approval",
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
  label: isWindows ? "Microphone Array" : "MacBook Pro Microphone",
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
  accessibility: { supported: !isWindows, granted: !isWindows },
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
  platform: isWindows ? "win32-x64-cuda" : "darwin-arm64",
  activeModelFamilyId: "whisper-large-v3",
  recommendedDefaultFamilyId: isWindows ? "whisper-large-v3" : "parakeet-unified-en-0-6b",
  modelLibraryFamilyIds: harnessParams.has("apply")
    ? ["whisper-large-v3", "qwen3-asr-1-7b"]
    : ["whisper-large-v3"],
  families: [
    ...(!isWindows ? [{
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
    }] : []),
    {
      familyId: "whisper-large-v3",
      displayName: "Whisper large-v3",
      capabilities: afterStopCapabilities,
      recommendedDefault: isWindows,
      active: true,
      inLibrary: true,
      artifacts: activeArtifacts,
      profiles: ["high", "medium", "low"].map((tier, index) => ({
        profileId: `whisper-large-v3-${tier}`,
        tier: tier as "high" | "medium" | "low",
        artifactId: isWindows ? activeArtifactIds[0]! : `whisper-large-v3-${tier}`,
        engine,
        precision: tier === "high" ? "float16" : tier === "medium" ? "int8_float16" : "int8",
        expectedMemoryMinBytes: isWindows ? (4 - index) * GIBIBYTE : (3 - index) * GIBIBYTE,
        expectedMemoryMaxBytes: isWindows ? (5 - index) * GIBIBYTE : (4 - index) * GIBIBYTE,
        memoryBasis: "estimated" as const,
      })),
    },
    {
      familyId: "qwen3-asr-0-6b",
      displayName: "Qwen3-ASR 0.6B",
      capabilities: afterStopCapabilities,
      recommendedDefault: false,
      active: false,
      inLibrary: false,
      artifacts: qwen06Artifacts,
      profiles: ["high", "medium", "low"].map((tier, index) => ({
        profileId: `qwen3-asr-0-6b-${tier}`,
        tier: tier as "high" | "medium" | "low",
        artifactId: qwen06ArtifactIds[index]!,
        engine: isWindows ? "crispasr" as const : "mlx-audio" as const,
        precision: isWindows
          ? (["float16", "q8_0", "q4_k"] as const)[index]!
          : (["bf16", "8-bit", "4-bit"] as const)[index]!,
        expectedMemoryMinBytes: (
          isWindows ? [2.5, 1.6, 1.2] : [2, 1.4, 1.1]
        )[index]! * GIBIBYTE,
        expectedMemoryMaxBytes: (
          isWindows ? [3.5, 2.6, 2.2] : [3, 2.3, 2]
        )[index]! * GIBIBYTE,
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
        engine: isWindows ? "crispasr" as const : "mlx-audio" as const,
        precision: isWindows
          ? (["float16", "q8_0", "q4_k"] as const)[index]!
          : (["bf16", "8-bit", "4-bit"] as const)[index]!,
        expectedMemoryMinBytes: (
          isWindows ? [4.8, 2.6, 1.8] : [4.2, 2.6, 1.8]
        )[index]! * GIBIBYTE,
        expectedMemoryMaxBytes: (
          isWindows ? [5.8, 3.6, 2.8] : [5.4, 3.6, 2.8]
        )[index]! * GIBIBYTE,
        memoryBasis: "estimated" as const,
      })),
    },
    {
      familyId: "whisper-large-v2",
      displayName: "Whisper large-v2",
      capabilities: afterStopCapabilities,
      recommendedDefault: false,
      active: false,
      inLibrary: false,
      artifacts: [{
        artifactId: "whisper-large-v2-shared",
        displayName: "Whisper large-v2 shared model data",
        backend,
        modelId: "curated/whisper-large-v2",
        storageDirectory: "whisper-large-v2",
        revision: "f".repeat(40),
        license: "Undeclared",
        expectedDownloadBytes: 3_000_000_000,
      }],
      profiles: ["high", "medium", "low"].map((tier, index) => ({
        profileId: `whisper-large-v2-${tier}`,
        tier: tier as "high" | "medium" | "low",
        artifactId: "whisper-large-v2-shared",
        engine,
        precision: tier === "high" ? "float16" : tier === "medium" ? "int8_float16" : "int8",
        expectedMemoryMinBytes: (3 - index) * GIBIBYTE,
        expectedMemoryMaxBytes: (4 - index) * GIBIBYTE,
        memoryBasis: "estimated" as const,
      })),
    },
  ],
  verifications: [
    ...(!isWindows ? parakeetArtifacts.map((artifact) => ({
      familyId: "parakeet-unified-en-0-6b" as const,
      artifactId: artifact.artifactId,
      present: false,
      verified: false,
      verificationStatus: "missing" as const,
      sizeBytes: 0,
      expectedBytes: artifact.expectedDownloadBytes,
      verifiedFiles: 0,
      expectedFiles: 18,
    })) : []),
    ...activeArtifacts.map((artifact) => ({
      familyId: "whisper-large-v3" as const,
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
    ...qwen06Artifacts.map((artifact) => ({
      familyId: "qwen3-asr-0-6b" as const,
      artifactId: artifact.artifactId,
      present: false,
      verified: false,
      verificationStatus: "missing" as const,
      sizeBytes: 0,
      expectedBytes: artifact.expectedDownloadBytes,
      verifiedFiles: 0,
      expectedFiles: 1,
    })),
    {
      familyId: "whisper-large-v2" as const,
      artifactId: "whisper-large-v2-shared",
      present: false,
      verified: false,
      verificationStatus: "missing" as const,
      sizeBytes: 0,
      expectedBytes: 3_000_000_000,
      verifiedFiles: 0,
      expectedFiles: 1,
    },
  ],
  unmanagedEntries: isWindows ? [
    {
      name: "legacy-qwen3-asr",
      kind: "directory",
      reason: "unmanaged",
      sizeBytes: 2_300_000_000,
    },
    {
      name: ".localscribe-model-install-deadbeefdeadbeefdeadbeefdeadbeef",
      kind: "directory",
      reason: "interrupted-install",
      sizeBytes: null,
    },
  ] : [],
};

const diagnostics: Diagnostics = {
  platform: harnessPlatform,
  architecture: isWindows ? "x64" : "arm64",
  backend,
  databaseIntegrity: "ok",
  /*
   * Added when `scripts/` joined the typecheck: the contract has carried this
   * field since unreadable history rows became countable, and the harness
   * fixture had silently drifted behind it.
   */
  unreadableRecords: 0,
  model: {
    familyId: "whisper-large-v3",
    artifactId: activeArtifactIds[0]!,
    profileId: "whisper-large-v3-high",
    displayName: "Whisper large-v3 High",
    modelId: "curated/whisper-large-v3-high",
    storageDirectory: activeArtifacts[0]!.storageDirectory,
    installed: modelVerified,
    loaded: harnessParams.has("apply-success"),
    present: modelPresent,
    verified: modelVerified,
    verificationStatus: harnessVerification,
    sizeBytes: modelPresent ? activeArtifacts[0]!.expectedDownloadBytes : 0,
    expectedBytes: activeArtifacts[0]!.expectedDownloadBytes,
    verifiedFiles: modelVerified ? 1 : 0,
    expectedFiles: 1,
    revision: "1".repeat(40),
    license: "MIT",
  },
  accelerator: {
    kind: isWindows ? "nvidia-cuda" : "apple-unified",
    displayName: isWindows ? "NVIDIA GeForce RTX 3060 Laptop GPU" : "Apple M-series GPU",
    totalMemoryBytes: (isWindows ? 6 : 48) * GIBIBYTE,
    freeMemoryBytes: (isWindows ? 5 : 30) * GIBIBYTE,
    memoryBasis: "measured",
  },
  performance: {
    preference: persistedSettings.modelPerformanceMode,
    resolvedTier: usesCustomSettings ? "low" : isWindows ? "medium" : "high",
    fitsMemoryBudget: true,
    resolutionReason: usesCustomSettings
      ? `Low is the saved explicit profile for this ${isWindows ? "PC" : "Mac"}.`
      : isWindows
        ? "Medium fits the currently reported NVIDIA VRAM."
        : "High fits the currently reported unified memory.",
    reservedHeadroomBytes: isWindows ? GIBIBYTE : 2 * GIBIBYTE,
    requiredFreeMemoryBytes: isWindows ? 5 * GIBIBYTE : 12 * GIBIBYTE,
    options: ["high", "medium", "low"].map((tier, index) => ({
      tier: tier as "high" | "medium" | "low",
      modelKey: tier,
      profileId: `whisper-large-v3-${tier}`,
      artifactId: isWindows ? activeArtifactIds[0]! : `whisper-large-v3-${tier}`,
      displayName: `Whisper large-v3 ${tier}`,
      engine: backend,
      precision: tier === "high" ? "float16" : tier === "medium" ? "int8_float16" : "int8",
      expectedMemoryMinBytes: isWindows ? (4 - index) * GIBIBYTE : (3 - index) * GIBIBYTE,
      expectedMemoryMaxBytes: isWindows ? (5 - index) * GIBIBYTE : (4 - index) * GIBIBYTE,
      memoryBasis: "estimated" as const,
      expectedDownloadBytes: activeArtifacts.find((artifact) => (
        artifact.artifactId === (isWindows ? activeArtifactIds[0]! : `whisper-large-v3-${tier}`)
      ))!.expectedDownloadBytes,
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
      appId: isWindows ? "notepad.exe" : "com.apple.TextEdit",
      label: isWindows ? "Notepad" : "TextEdit",
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
      const family = catalog.families.find((candidate) => candidate.familyId === request.familyId);
      const appliedTier = request.performanceMode === "auto" ? "medium" : request.performanceMode;
      const profile = family?.profiles.find((candidate) => candidate.tier === appliedTier)
        ?? family?.profiles[0];
      return {
        applied: true as const,
        appliedSelection: {
          familyId: request.familyId,
          artifactId: profile?.artifactId ?? "whisper-large-v3-medium",
          tier: profile?.tier ?? "medium",
          asrMode: request.asrMode,
        },
        settings: persistedSettings,
        catalog,
        diagnostics: {
          ...diagnostics,
          model: {
            ...diagnostics.model,
            loaded: true,
          },
          performance: {
            ...diagnostics.performance,
            preference: request.performanceMode,
            resolvedTier: request.performanceMode === "auto" ? diagnostics.performance.resolvedTier : request.performanceMode,
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
