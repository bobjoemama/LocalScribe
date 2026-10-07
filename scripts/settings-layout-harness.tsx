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
  type DictionaryEntry,
  type DictionarySaveInput,
  type LaunchAtLoginStatus,
  type LocalScribeApi,
  type ModelCatalog,
  type ModelSelectionApplyRequest,
  type ModelInstallProgress,
  type ModelInstallRequest,
  type PermissionSnapshot,
  type Snippet,
  type SnippetSaveInput,
} from "../src/shared/contracts";
import { SettingsApp } from "../src/renderer/settings/SettingsApp";
import { CleanupScreen, ModelsScreen, SettingsModal } from "../src/renderer/settings/screens/StyleSettings";
import "../src/renderer/styles.css";
import "../src/renderer/workspace-theme.css";

const clipboardWrites: string[] = [];
const confirmCalls: string[] = [];
let confirmAnswer = true;
window.confirm = (message = "") => { confirmCalls.push(message); return confirmAnswer; };
const modelProgressListeners = new Set<(progress: ModelInstallProgress) => void>();
let modelOperationWait: Promise<void> | null = null;
let finishModelWait: (() => void) | null = null;
let dictionaryEntries: DictionaryEntry[] = [
  { id: "44444444-4444-4444-8444-444444444444", phrase: "local scribe", replacement: "LocalScribe", createdAt: 1 },
  { id: "55555555-5555-4555-8555-555555555555", phrase: "project name", replacement: "NovaOS", createdAt: 2 },
];
let snippetEntries: Snippet[] = [
  { id: "66666666-6666-4666-8666-666666666666", trigger: "my sign off", expansion: "\n  Best,\n    Alex\n", createdAt: 1 },
  { id: "77777777-7777-4777-8777-777777777777", trigger: "meeting link", expansion: "https://example.com/meeting", createdAt: 2 },
];
const librarySaveCalls: Array<{ kind: "dictionary" | "snippets"; input: DictionarySaveInput | SnippetSaveInput }> = [];
let failNextLibrarySave = false;
let releaseLibrarySave: (() => void) | null = null;
let nextLibrarySaveWait: Promise<void> | null = null;
let nextLibraryId = 1;
const waitForLibrarySave = async () => {
  const waiting = nextLibrarySaveWait;
  nextLibrarySaveWait = null;
  if (waiting) await waiting;
};
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText: async (text: string) => { clipboardWrites.push(text); } },
});
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
declare const __LOCALSCRIBE_HARNESS_FAMILIES__: ModelCatalog["families"];
const fixtureFamilies = __LOCALSCRIBE_HARNESS_FAMILIES__;
const primaryFamily = fixtureFamilies.find(family => family.familyId === "qwen3-asr-0-6b")!;
const activeArtifacts = primaryFamily.artifacts;
const activeArtifactIds = activeArtifacts.map(artifact => artifact.artifactId);
const backend = activeArtifacts[0]!.backend;

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

const catalog: ModelCatalog = {
  platform: "darwin-arm64",
  activeModelFamilyId: "qwen3-asr-0-6b",
  recommendedDefaultFamilyId: "parakeet-unified-en-0-6b",
  modelLibraryFamilyIds: harnessParams.has("apply") ? ["qwen3-asr-0-6b", "qwen3-asr-1-7b"] : ["qwen3-asr-0-6b"],
  families: fixtureFamilies.map(family => ({ ...family, active: family.familyId === "qwen3-asr-0-6b", inLibrary: family.familyId === "qwen3-asr-0-6b" || (harnessParams.has("apply") && family.familyId === "qwen3-asr-1-7b") })),
  verifications: fixtureFamilies.flatMap(family => family.artifacts.map(artifact => {
    const state = family.familyId === "qwen3-asr-0-6b" ? harnessVerification : harnessParams.has("apply") && family.familyId === "qwen3-asr-1-7b" ? "verified" as const : "missing" as const;
    return { familyId: family.familyId, artifactId: artifact.artifactId, present: state !== "missing", verified: state === "verified", verificationStatus: state, sizeBytes: state !== "missing" ? artifact.expectedDownloadBytes : 0, expectedBytes: artifact.expectedDownloadBytes, verifiedFiles: state === "verified" ? 1 : 0, expectedFiles: 1 };
  })),
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
  history: {
    list: async () => ({ items: [
      { id: "11111111-1111-4111-8111-111111111111", createdAt: Date.now(), durationMs: 12000,
        text: "Please send the updated meeting notes by Friday. I’ll review them before our next discussion.",
        language: "en", modelId: "fixture", status: "complete", sourceAppId: "com.apple.mail" },
      { id: "22222222-2222-4222-8222-222222222222", createdAt: Date.now() - 3600000, durationMs: 7000,
        text: "Remember to pick up coffee on the way home.",
        language: "en", modelId: "fixture", status: "complete", sourceAppId: "com.apple.Notes" },
      { id: "33333333-3333-4333-8333-333333333333", createdAt: Date.now() - 86_400_000, durationMs: 125000,
        text: Array.from({ length: 12 }, (_, index) => `Note ${index + 1}: The project review will cover the latest changes, the remaining questions, and the next steps. Please keep the feedback specific and include the reason for each suggestion.`).join("\n\n"),
        language: "en", modelId: "fixture", status: "complete", sourceAppId: "com.apple.TextEdit" },
    ], skippedUnreadable: 0 }),
    onChanged: () => () => undefined,
  },
  dictionary: {
    list: async () => dictionaryEntries.map(entry => ({ ...entry })),
    save: async (input: DictionarySaveInput) => {
      librarySaveCalls.push({ kind: "dictionary", input: { ...input } });
      await waitForLibrarySave();
      if (failNextLibrarySave) { failNextLibrarySave = false; throw new Error("Another dictionary term already uses that heard phrase."); }
      const old = dictionaryEntries.find(entry => entry.id === input.id);
      if (input.id && !old) throw new Error("Fixture edit identity missing");
      const saved: DictionaryEntry = old
        ? { ...old, ...input }
        : { ...input, id: `00000000-0000-4000-8000-${String(nextLibraryId++).padStart(12, "0")}`, createdAt: Date.now() };
      dictionaryEntries = [saved, ...dictionaryEntries.filter(entry => entry.id !== saved.id)];
      return saved;
    },
  },
  snippets: {
    list: async () => snippetEntries.map(entry => ({ ...entry })),
    save: async (input: SnippetSaveInput) => {
      librarySaveCalls.push({ kind: "snippets", input: { ...input } });
      await waitForLibrarySave();
      if (failNextLibrarySave) { failNextLibrarySave = false; throw new Error("Another snippet already uses that spoken trigger."); }
      const old = snippetEntries.find(entry => entry.id === input.id);
      if (input.id && !old) throw new Error("Fixture edit identity missing");
      const saved: Snippet = old
        ? { ...old, ...input }
        : { ...input, id: `00000000-0000-4000-8000-${String(nextLibraryId++).padStart(12, "0")}`, createdAt: Date.now() };
      snippetEntries = [saved, ...snippetEntries.filter(entry => entry.id !== saved.id)];
      return saved;
    },
  },
  system: {
    savedDataStatus: async () => ({ history: 0, dictionary: 0, snippets: 0, notes: 0 }),
    resetSavedData: async () => ({ reset: true, cleanupComplete: true }),
    showDataBackups: async () => undefined,
    appInfo: async () => ({ version: "0.1.0-dev.20", platform: "darwin" }),
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
    installModel: async (request: ModelInstallRequest) => {
      const waiting = modelOperationWait;
      modelOperationWait = null;
      if (waiting) await waiting;
      const family = catalog.families.find(family => family.familyId === request.familyId)!;
      const profile = family.profiles.find(profile => profile.tier === request.tier)!;
      const verification = catalog.verifications.find(entry => entry.artifactId === profile.artifactId)!;
      Object.assign(verification, { present: true, verified: true, verificationStatus: "verified", sizeBytes: verification.expectedBytes, verifiedFiles: verification.expectedFiles });
      return diagnostics;
    },
    onModelInstallProgress: (listener: (progress: ModelInstallProgress) => void) => { modelProgressListeners.add(listener); return () => modelProgressListeners.delete(listener); },
    removeModel: async () => diagnostics,
  },
  windows: {
    onNavigate: () => () => undefined,
    showSettings: async () => undefined,
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
    showWorkspace(): void;
    showModels(): void;
    showCleanup(): void;
    clipboardWrites: string[];
    confirmCalls: string[];
    setConfirmAnswer(answer: boolean): void;
    delayModelOperation(): void;
    sendModelProgress(progress: ModelInstallProgress): void;
    finishModelOperation(): void;
    librarySaveCalls: typeof librarySaveCalls;
    library(): { dictionary: DictionaryEntry[]; snippets: Snippet[] };
    failLibrarySave(): void;
    delayLibrarySave(): void;
    finishLibrarySave(): void;
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
  showWorkspace: () => root.render(<SettingsApp />),
  showModels: () => root.render(<ModelsScreen key={++renderSequence} />),
  showCleanup: () => root.render(<CleanupScreen key={++renderSequence} />),
  clipboardWrites,
  confirmCalls,
  setConfirmAnswer: (answer: boolean) => { confirmAnswer = answer; },
  delayModelOperation: () => { modelOperationWait = new Promise(resolve => { finishModelWait = resolve; }); },
  sendModelProgress: (progress: ModelInstallProgress) => { for (const listener of modelProgressListeners) listener(progress); },
  finishModelOperation: () => { finishModelWait?.(); finishModelWait = null; },
  librarySaveCalls,
  library: () => ({ dictionary: dictionaryEntries.map(entry => ({ ...entry })), snippets: snippetEntries.map(entry => ({ ...entry })) }),
  failLibrarySave: () => { failNextLibrarySave = true; },
  delayLibrarySave: () => { nextLibrarySaveWait = new Promise(resolve => { releaseLibrarySave = resolve; }); },
  finishLibrarySave: () => { releaseLibrarySave?.(); releaseLibrarySave = null; },
};
renderSettings();
