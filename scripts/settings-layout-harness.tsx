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
  type PermissionSnapshot,
} from "../src/shared/contracts";
import { SettingsModal } from "../src/renderer/settings/screens/StyleSettings";

const GIBIBYTE = 1_073_741_824;
const harnessParams = new URLSearchParams(window.location.search);
const harnessPlatform = harnessParams.get("platform") === "win32" ? "win32" : "darwin";
const harnessVerification = (
  ["missing", "invalid", "verified"].includes(harnessParams.get("verification") ?? "")
    ? harnessParams.get("verification")
    : "missing"
) as "missing" | "invalid" | "verified";
const harnessSettingsPreset = harnessParams.get("settings") === "custom" ? "custom" : "default";
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
const settingsPatchCalls: AppSettingsPatch[] = [];
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
};

const catalog: ModelCatalog = {
  platform: isWindows ? "win32-x64-cuda" : "darwin-arm64",
  activeModelFamilyId: "whisper-large-v3",
  modelLibraryFamilyIds: ["whisper-large-v3"],
  families: [
    {
      familyId: "whisper-large-v3",
      displayName: "Whisper large-v3",
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
      familyId: "qwen3-asr-1-7b",
      displayName: "Qwen3-ASR 1.7B",
      active: false,
      inLibrary: false,
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
  model: {
    familyId: "whisper-large-v3",
    artifactId: activeArtifactIds[0]!,
    profileId: "whisper-large-v3-high",
    displayName: "Whisper large-v3 High",
    modelId: "curated/whisper-large-v3-high",
    storageDirectory: activeArtifacts[0]!.storageDirectory,
    installed: modelVerified,
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
    onChanged: (listener) => {
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
    getPermissions: async () => permissions,
    getLaunchAtLoginStatus: async () => ({ ...launchAtLoginStatus }),
    diagnostics: async () => diagnostics,
    modelCatalog: async () => catalog,
    openPermission: async () => undefined,
    addModelFamily: async () => catalog,
    activateModelFamily: async () => catalog,
    installModel: async () => diagnostics,
    removeModel: async () => diagnostics,
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
    persisted(): AppSettings;
    remount(): void;
  };
}).__localScribeSettingsHarness = {
  patchCalls: settingsPatchCalls,
  persisted: () => persistedSettings,
  remount: renderSettings,
};
renderSettings();
