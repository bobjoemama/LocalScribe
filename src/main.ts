import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  net,
  nativeImage,
  protocol,
  screen,
  // `session` is this file's dictation-session state; the Electron export is
  // only ever the default partition, so it is named for what it is used for.
  session as electronSession,
  shell,
  systemPreferences,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import { z } from "zod";
import {
  appSettingsSchema,
  appSettingsPatchSchema,
  appProfileSchema,
  cancelLiveAudioSchema,
  dictionaryEntrySchema,
  finishLiveAudioSchema,
  IPC,
  liveAudioFrameSchema,
  liveAudioSessionSchema,
  persistedPrivateTextSchema,
  MAX_HISTORY_ITEMS,
  modelFamilyLibraryRequestSchema,
  modelInstallRequestSchema,
  modelRemoveRequestSchema,
  modelSelectionApplyRequestSchema,
  navigationTargetSchema,
  pillModeSchema,
  sessionFailureSchema,
  sessionSnapshotSchema,
  sanitizeSourceApplicationId,
  snippetSchema,
  transcribeAudioSchema,
  type Diagnostics,
  type AsrMode,
  type ModelCatalog,
  type ModelCapabilities,
  type ModelFamilyId,
  type ModelInstallProgress,
  type ModelPerformanceTier,
  type ModelSelectionApplyResult,
  type NavigationTarget,
  type PillMode,
  type LivePartialTranscript,
  type SessionSnapshot,
} from "./shared/contracts";
import { modelPerformanceTierLabel } from "./shared/modelPerformance";
import { transcribeAudioAdmission } from "./shared/dictationSession";
import { discardAudio, prepareTranscription } from "./main/session/transcribePrelude";
import { createFinalizeWatchdog } from "./main/session/finalizeWatchdog";
import { createNoticeTimer } from "./main/session/noticeTimer";
import { persistCompletedDictationHistory } from "./main/session/historyPersistence";
import {
  dictationMenuPolicy,
  rendererFailureRecoveryPolicy,
  sendToLiveRenderers,
} from "./main/session/rendererResilience";
import { normalizeDiagnosticCode } from "./shared/diagnosticsLog";
import {
  DiagnosticsRecorder,
  nullDiagnosticsRecorder,
  type DiagnosticsSink,
} from "./main/diagnostics/diagnosticsRecorder";
import { shortcutValidationRequestSchema } from "./shared/shortcuts";
import {
  applySettingsPatchTransaction,
  applyShortcutUpdateTransaction,
} from "./main/settings/settingsTransaction";
import { LocalDatabase } from "./main/persistence/database";
import {
  WorkerSupervisor,
  workerModelSelectionsMatch,
  type WorkerAcceleratorSnapshot,
  type WorkerModelSelection,
} from "./main/worker/workerSupervisor";
import { HotkeyService } from "./main/hotkeys/hotkeyService";
import { defaultMacControlMonitorPath, MacControlMonitor } from "./main/hotkeys/macControlMonitor";
import { reconcileAccessibilityHotkeys } from "./main/hotkeys/accessibilityReconciler";
import { InsertionService } from "./main/insertion/insertionService";
import { insertionDiagnosticEvent } from "./main/insertion/insertionDiagnostics";
import { dictionaryAsrContextForCapabilities } from "./shared/dictionaryContext";
import { applyLocalTextRules } from "./shared/textPipeline";
import { workerLanguageForModel } from "./shared/modelLanguage";
import { transformDictation } from "./shared/text";
import { normalizeDictationErrorMessage } from "./shared/dictationErrors";
import {
  loadRuntimePlatformModelCatalog,
  defaultSettingsForRuntimeCatalog,
  modelArtifactIsVerifiedNow,
  manifestForWorkerSelection,
  runtimeModelTier,
  workerComputeTypeForTier,
  resolveModelPerformance,
  verifyModelDirectory,
  verifyRuntimeModelCatalog,
  assertModelSelectionSupported,
  type ModelPerformanceResolution,
  type RuntimeModelCatalog,
  type RuntimePlatformModelCatalog,
  type RuntimeModelTierSpec,
} from "./main/modelSpec";
import type { LiveAudioSink } from "./shared/liveAudioTransport";
import {
  buildModelCatalogSnapshot,
  modelRootForUserData,
} from "./main/modelCatalogSnapshot";
import {
  installVerifiedModelArtifact,
  quarantineAndRemoveModelArtifact,
} from "./main/modelOperations";
import { verifyPackagedResourceIntegrity } from "./main/resourceIntegrity";
import {
  permissionSettingsUrl,
  permissionSnapshotForPlatform,
  runtimeArchitectureFor,
  runtimePlatformFor,
} from "./main/platformCapabilities";
import { SETTINGS_WINDOW_LAYOUT } from "./shared/windowLayout.mts";
import {
  PILL_LAYOUT,
  PILL_WINDOW_BOTTOM_MARGIN,
  pillHoverModeForPointer,
  pillSizeFor,
} from "./shared/pillLayout";
import {
  RENDERER_PROTOCOL_SCHEME,
  rendererUrlForRuntime,
  resolvePackagedRendererPath,
  type RendererSurface,
} from "./main/rendererProtocol";
import {
  rendererPermissionCheckAllowed,
  rendererPermissionRequestAllowed,
} from "./main/rendererPermissions";
import { writePrivateFile } from "./main/persistence/privateFile";
import {
  cleanStaleAudioCaches,
  createAudioCache,
  removeAudioCache,
} from "./main/audioCache";
import { assertRendererSurfaceCanInvoke } from "./main/ipcAuthorization";
import {
  launchAtLoginStatusFor,
  loginItemSettings,
  shouldOpenSettingsAtStartup,
} from "./main/launchAtLogin";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

// Electron requires custom schemes to be declared before app readiness.  Do
// not grant bypassCSP, service-worker, or other broad capabilities: the
// renderer only needs a normal secure origin and Fetch support for its own
// bundled assets.
protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_PROTOCOL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);

let settingsWindow: BrowserWindow | null = null;
let pillWindow: BrowserWindow | null = null;
let scratchpadWindow: BrowserWindow | null = null;
let database: LocalDatabase;
let worker: WorkerSupervisor;
let hotkeys: HotkeyService;
let tray: Tray | null = null;
let pillDisplayTimer: NodeJS.Timeout | null = null;
let accessibilityTimer: NodeJS.Timeout | null = null;
/** One timer factory for both session watchdogs, so neither can hold the event loop open. */
function unrefTimer(callback: () => void, milliseconds: number): { cancel(): void } {
  const timer = setTimeout(callback, milliseconds);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
/*
 * `finalizing` is the only dictation state main cannot leave on its own, so it
 * is the only one that could wedge the app until restart. See
 * ./main/session/finalizeWatchdog.
 */
const finalizeWatchdog = createFinalizeWatchdog({
  setTimer: unrefTimer,
  currentSession: () => session,
  fail: (reason) => {
    failSession(reason);
  },
  record: (event) => diagnostics.record(event),
});
/*
 * `success` and `error` are notices that have to clear themselves. See
 * ./main/session/noticeTimer for why arming them from the transition rather
 * than from the caller is what keeps a failed database write from stranding
 * the session in `success`.
 */
const noticeTimer = createNoticeTimer({
  setTimer: unrefTimer,
  currentSession: () => session,
  dismiss: (state) => {
    if (state === "error") insertion.cancelSession();
    setSession({ state: "idle" });
  },
});
let audioCacheRoot: string | null = null;
/**
 * Where dictation failures get recorded.
 *
 * Starts as the null sink so every call site can record unconditionally from
 * the first line of startup, before the real recorder's directory is known.
 */
let diagnostics: DiagnosticsSink = nullDiagnosticsRecorder;
let pillMode: PillMode = "collapsed";
// Environment-selected executable helpers are a useful development seam, but
// must never override the helper bundled into a packaged application.
const insertion = new InsertionService({
  allowNativeHelperEnvironmentOverride: !app.isPackaged,
  nativeHelperWorkingDirectory: app.getAppPath(),
});
let session: SessionSnapshot = { state: "idle" };
let quitting = false;
let workerInitialized = false;
let databaseInitialized = false;
let startupPromise: Promise<void> | null = null;
let runtimeReleasePromise: Promise<void> | null = null;
const rendererRecoveryInFlight = new Set<RendererSurface>();
const handledRendererFailures = new WeakSet<WebContents>();
const retiringRendererWindows = new WeakSet<BrowserWindow>();
let runtimeModelPlatformCatalog: RuntimePlatformModelCatalog | null = null;
let modelResolution: ModelPerformanceResolution | null = null;
let previousAutoTier: ModelPerformanceTier | undefined;
let activeDictationTier: ModelPerformanceTier | undefined;
let activeSessionId: string | null = null;
let activeLiveSession: {
  sessionId: string;
  sink: LiveAudioSink;
  resolution: ModelPerformanceResolution;
  startedAt: number;
} | null = null;
let activeSessionModelResolution: {
  sessionId: string;
  promise: Promise<ModelPerformanceResolution>;
} | null = null;
let acceleratorSnapshot: WorkerAcceleratorSnapshot | null = null;
let modelOperationTail: Promise<void> = Promise.resolve();
let modelOperationCount = 0;
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

const uuidSchema = z.string().uuid();
const limitSchema = z.number().int().min(1).max(MAX_HISTORY_ITEMS).optional();
const dictionaryInputSchema = dictionaryEntrySchema.pick({ phrase: true, replacement: true });
const snippetInputSchema = snippetSchema.pick({ trigger: true, expansion: true });
const profileInputSchema = appProfileSchema.omit({ id: true, createdAt: true });
const scratchpadSchema = persistedPrivateTextSchema;

function platformModelCatalog(): RuntimePlatformModelCatalog {
  if (!runtimeModelPlatformCatalog) throw new Error("The packaged model catalog was not loaded");
  return runtimeModelPlatformCatalog;
}

function modelCatalog(
  familyId: ModelFamilyId = database.getSettings().activeModelFamilyId,
): RuntimeModelCatalog {
  const catalog = platformModelCatalog().families[familyId];
  if (!catalog) throw new Error(`Model family ${familyId} is unavailable on this platform`);
  return catalog;
}

function assertModelLanguageSupported(
  language: string,
  capabilities: ModelCapabilities,
  modelName: string,
): void {
  void workerLanguageForModel(language, capabilities, modelName);
}

function workerLanguageForActiveModel(
  settings: ReturnType<LocalDatabase["getSettings"]> = database.getSettings(),
): string {
  const catalog = modelCatalog(settings.activeModelFamilyId);
  return workerLanguageForModel(settings.language, catalog.capabilities, catalog.displayName);
}

function runtimeModelManifestDirectory(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "model-manifest")
    : path.join(app.getAppPath(), "resources", "model-manifest");
}

function canSwitchModelNow(): boolean {
  return session.state === "idle";
}

function assertModelSwitchAllowed(): void {
  if (!canSwitchModelNow()) {
    throw new Error("Finish or cancel the active dictation before changing local speech models.");
  }
}

function assertFamilyInLibrary(familyId: ModelFamilyId): void {
  if (!database.getSettings().modelLibraryFamilyIds.includes(familyId)) {
    throw new Error("Add this curated model family to the local library before using its artifacts.");
  }
}

function runExclusiveModelOperation<T>(operation: () => Promise<T>): Promise<T> {
  modelOperationCount += 1;
  refreshNativeMenus();
  const result = modelOperationTail.catch(() => undefined).then(operation);
  modelOperationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result.finally(() => {
    modelOperationCount -= 1;
    refreshNativeMenus();
  });
}

function modelOperationInProgress(): boolean {
  return modelOperationCount > 0;
}

/**
 * Returns packaged metadata plus cryptographic disk status for every curated
 * artifact. It intentionally does not probe hardware or start the worker.
 */
async function collectModelCatalog(): Promise<ModelCatalog> {
  return collectModelCatalogForSettings(database.getSettings());
}

async function collectModelCatalogForSettings(
  settings: ReturnType<LocalDatabase["getSettings"]>,
): Promise<ModelCatalog> {
  const catalog = platformModelCatalog();
  return buildModelCatalogSnapshot({
    settings,
    catalog,
    modelRoot: modelRootForUserData(app.getPath("userData")),
  });
}

function unavailableAccelerator(): Diagnostics["accelerator"] {
  return {
    kind: "apple-unified",
    displayName: "Apple Silicon GPU · MLX",
    totalMemoryBytes: null,
    freeMemoryBytes: null,
    memoryBasis: "unavailable",
  };
}

function acceleratorDiagnostics(): Diagnostics["accelerator"] {
  if (!acceleratorSnapshot) return unavailableAccelerator();
  return {
    kind: acceleratorSnapshot.kind,
    // This is hardware identity only. The selected engine (MLX, CoreML/ANE,
    // FluidAudio, MLX Whisper, or MLX Audio) is reported separately from its catalog tier.
    displayName: acceleratorSnapshot.displayName,
    totalMemoryBytes: acceleratorSnapshot.totalMemoryBytes,
    freeMemoryBytes: acceleratorSnapshot.freeMemoryBytes,
    memoryBasis: acceleratorSnapshot.memoryBasis,
  };
}

function memorySnapshot() {
  return {
    totalBytes: acceleratorSnapshot?.totalMemoryBytes ?? null,
    freeBytes: acceleratorSnapshot?.freeMemoryBytes ?? null,
  };
}

async function probeUnloadedAccelerator(): Promise<void> {
  if (worker.loadedSelection()) {
    throw new Error("Accelerator probing requires the current local speech model to be unloaded.");
  }
  try {
    acceleratorSnapshot = await worker.deviceInfo();
  } catch (error) {
    acceleratorSnapshot = null;
    if (!quitting) console.warn("Accelerator diagnostics are unavailable", error);
  }
}

function resolveSelection(
  familyId: ModelFamilyId,
  preference: ReturnType<LocalDatabase["getSettings"]>["modelPerformanceMode"],
  memory = memorySnapshot(),
): ModelPerformanceResolution {
  const next = resolveModelPerformance({
    preference,
    catalog: modelCatalog(familyId),
    memory,
    previousTier: previousAutoTier,
    activeDictationTier,
  });
  return next;
}

async function refreshModelResolution(options: {
  reprobeUnloaded?: boolean;
  familyId?: ModelFamilyId;
  preference?: ReturnType<LocalDatabase["getSettings"]>["modelPerformanceMode"];
  memory?: ReturnType<typeof memorySnapshot>;
} = {}): Promise<ModelPerformanceResolution> {
  const settings = database.getSettings();
  const familyId = options.familyId ?? settings.activeModelFamilyId;
  const preference = options.preference ?? settings.modelPerformanceMode;
  if (options.reprobeUnloaded) await probeUnloadedAccelerator();
  const next = resolveSelection(familyId, preference, options.memory ?? memorySnapshot());
  modelResolution = next;
  if (
    session.state === "idle"
    && familyId === settings.activeModelFamilyId
    && preference === "auto"
    && next.fitsMemoryBudget
  ) {
    previousAutoTier = next.effectiveTier;
  }
  return next;
}

/**
 * A live telemetry sample includes the memory already held by the warm model.
 * Add back only the curated minimum allocation for selection policy, capped
 * at physical memory. That is the conservative lower bound for the memory the
 * current runtime would release; using the maximum could overstate capacity
 * and select a tier that cannot actually load. Diagnostics continue to expose
 * the unmodified reading.
 */
function memorySnapshotWithoutWarmModel(
  snapshot: WorkerAcceleratorSnapshot,
  warmResolution: ModelPerformanceResolution,
): ReturnType<typeof memorySnapshot> {
  return {
    totalBytes: snapshot.totalMemoryBytes,
    freeBytes: Math.min(
      snapshot.totalMemoryBytes,
      snapshot.freeMemoryBytes + warmResolution.tier.acceleratorMemory.minimumBytes,
    ),
  };
}

async function refreshAutoResolutionAtRecordingBoundary(): Promise<ModelPerformanceResolution> {
  const settings = database.getSettings();
  const warmSelection = worker.loadedSelection();
  if (!warmSelection) {
    const coldResolution = await refreshModelResolution({ reprobeUnloaded: true });
    if (coldResolution.fitsMemoryBudget) previousAutoTier = coldResolution.effectiveTier;
    return coldResolution;
  }

  const cached = modelResolution;
  const cachedMatchesWarmSelection = cached !== null
    && cached.preference === "auto"
    && cached.tier.familyId === settings.activeModelFamilyId
    && cached.fitsMemoryBudget
    && workerModelSelectionsMatch(warmSelection, workerSelection(cached.tier, settings.asrMode));
  try {
    const liveSnapshot = await worker.deviceInfo();
    acceleratorSnapshot = liveSnapshot;
    if (!cachedMatchesWarmSelection) {
      throw new Error("The warm local speech model does not match the active Auto selection.");
    }
    const next = await refreshModelResolution({
      memory: memorySnapshotWithoutWarmModel(liveSnapshot, cached),
    });
    /*
     * Auto's policy is memory-only, so freeing memory between dictations can
     * drift the selection onto a tier in the same family whose artifact was
     * never downloaded — tiers are separate downloads. Switching to it kills
     * the worker process (the unload guarantee) and only then discovers the
     * artifact is missing, so the user loses a working warm model and the
     * dictation. Prefer the warm tier that demonstrably loads.
     *
     * The guard has to be proof, not a hint. It was a size-only probe, which a
     * corrupted-in-place artifact passes: the warm model was then killed and
     * the load failed on the digest, costing the user a working model and the
     * dictation in progress. `modelArtifactIsVerifiedNow` answers only for
     * artifacts a full SHA-256 pass already matched at exactly their current
     * file identity, so "yes" means the load cannot fail verification, and
     * "no" simply keeps the tier that is already working.
     */
    if (
      next.effectiveTier !== cached.effectiveTier
      && !(await modelArtifactIsVerifiedNow(
        modelRootForUserData(app.getPath("userData")),
        next.tier.manifest,
      ))
    ) {
      console.warn(
        `Auto resolved to the ${next.effectiveTier} tier, which is not verified at its current `
        + `file identity; keeping the warm ${cached.effectiveTier} tier.`,
      );
      diagnostics.record({
        stage: "model",
        event: "auto_tier_held",
        outcome: "skipped",
        modelTier: next.effectiveTier,
      });
      modelResolution = cached;
      return cached;
    }
    if (next.fitsMemoryBudget) previousAutoTier = next.effectiveTier;
    return next;
  } catch (error) {
    // A transient telemetry failure must not evict or fail a known-safe warm
    // model. If the cached selection is inconsistent, fail closed instead.
    if (cachedMatchesWarmSelection) {
      if (!quitting) console.warn("Live accelerator telemetry is unavailable; keeping the safe warm Auto tier", error);
      return cached;
    }
    throw error;
  }
}

async function currentModelResolution(): Promise<ModelPerformanceResolution> {
  if (
    activeSessionModelResolution
    && activeSessionModelResolution.sessionId === activeSessionId
  ) {
    return activeSessionModelResolution.promise;
  }
  // A failed startup probe must be recoverable without restarting the app.
  // Retrying is safe only while idle and cold: diagnostics must never evict a
  // warm runtime merely to obtain a fresher memory reading.
  if (
    session.state === "idle"
    && acceleratorSnapshot === null
    && worker.loadedSelection() === null
  ) {
    return refreshModelResolution({ reprobeUnloaded: true });
  }
  if (modelResolution) return modelResolution;
  // Diagnostics and status refreshes are observational. They reuse the last
  // unloaded-device snapshot and must never evict a ready speech model.
  if (session.state === "idle") return refreshModelResolution();
  return resolveModelPerformance({
    preference: database.getSettings().modelPerformanceMode,
    catalog: modelCatalog(),
    memory: memorySnapshot(),
    previousTier: previousAutoTier,
    activeDictationTier,
  });
}

function workerSelection(
  tier: RuntimeModelTierSpec,
  asrMode: AsrMode = "after-stop",
): WorkerModelSelection {
  return {
    modelId: tier.manifest.modelId,
    tier: tier.tier,
    computeType: workerComputeTypeForTier(tier),
    asrMode,
  };
}

function assertResolutionFitsMemory(resolution: ModelPerformanceResolution): void {
  if (resolution.fitsMemoryBudget) return;
  const required = resolution.requiredMemoryBytes
    ?? resolution.tier.acceleratorMemory.maximumBytes;
  const available = acceleratorSnapshot?.freeMemoryBytes;
  const detail = available === undefined || available === null
    ? "accelerator memory could not be measured"
    : `${Math.round(available / 1024 ** 3)} GiB is currently available`;
  throw new Error(
    `${resolution.effectiveTier} mode needs ${Math.ceil(required / 1024 ** 3)} GiB of free accelerator memory including reserved headroom; ${detail}. Choose a lower mode or free memory and refresh diagnostics.`,
  );
}

function resolutionReasonMessage(resolution: ModelPerformanceResolution): string {
  // Never interpolate the raw tier enum: this string is rendered verbatim
  // beside a heading that uses the product label, so "medium" next to
  // "Medium" read as two different facts.
  const tier = modelPerformanceTierLabel(resolution.effectiveTier);
  switch (resolution.reason) {
    case "explicit":
      return `${tier} was selected explicitly.`;
    case "dictation-active":
      return `${tier} is pinned until the active dictation finishes.`;
    case "auto-highest-fit":
      return `Auto selected ${tier}, the highest tier that fits the current memory budget.`;
    case "auto-hysteresis-hold":
      return `Auto kept ${tier} to avoid switching after a small memory change.`;
    case "auto-insufficient-memory":
      return "Auto could not verify enough free accelerator memory. Dictation stays blocked until a tier fits.";
  }
}

async function collectDiagnosticsForResolution(
  resolution: ModelPerformanceResolution,
  asrMode: AsrMode = database.getSettings().asrMode,
): Promise<Diagnostics> {
  const modelRoot = path.join(app.getPath("userData"), "models");
  const catalog = modelCatalog(resolution.tier.familyId);
  const verifications = await verifyRuntimeModelCatalog(modelRoot, catalog);
  const model = resolution.tier.manifest;
  const verification = verifications[resolution.effectiveTier];
  if (!verification) {
    throw new Error(`No verification was produced for the selected ${resolution.effectiveTier} profile`);
  }
  return {
    platform: runtimePlatformFor(process.platform),
    architecture: runtimeArchitectureFor(process.arch),
    backend: model.backend,
    databaseIntegrity: database.integrityCheck(),
    unreadableRecords: database.unreadableRecordCount(),
    model: {
      familyId: resolution.tier.familyId,
      artifactId: resolution.tier.artifactId,
      profileId: resolution.tier.profileId,
      displayName: model.displayName,
      modelId: model.modelId,
      storageDirectory: model.storageDirectory,
      // `installed` is retained for the current renderer, but deliberately
      // means cryptographically verified rather than merely present.
      installed: verification.verified,
      loaded: workerModelSelectionsMatch(
        worker.loadedSelection(),
        workerSelection(resolution.tier, asrMode),
      ),
      ...verification,
      revision: model.revision,
      license: model.license,
    },
    accelerator: acceleratorDiagnostics(),
    performance: {
      preference: resolution.preference,
      resolvedTier: resolution.effectiveTier,
      fitsMemoryBudget: resolution.fitsMemoryBudget,
      resolutionReason: resolutionReasonMessage(resolution),
      reservedHeadroomBytes: resolution.reservedHeadroomBytes,
      requiredFreeMemoryBytes: resolution.requiredMemoryBytes,
      options: Object.values(catalog.tiers).flatMap((tier) => {
        if (!tier) return [];
        const tierVerification = verifications[tier.tier];
        if (!tierVerification) {
          throw new Error(`No verification was produced for the ${tier.tier} profile`);
        }
        return {
          tier: tier.tier,
          modelKey: tier.modelKey,
          profileId: tier.profileId,
          artifactId: tier.artifactId,
          displayName: tier.manifest.displayName,
          engine: tier.engine,
          precision: tier.precision,
          expectedMemoryMinBytes: tier.acceleratorMemory.minimumBytes,
          expectedMemoryMaxBytes: tier.acceleratorMemory.maximumBytes,
          memoryBasis: tier.acceleratorMemory.evidence.kind,
          expectedDownloadBytes: tier.expectedDownloadBytes,
          qualityNote: tier.tier === "high"
            ? "Best accuracy · highest memory use"
            : tier.tier === "medium"
              ? "Balanced accuracy and memory use"
              : "Lowest memory use · may reduce accuracy",
          verificationStatus: tierVerification.verificationStatus,
          installed: tierVerification.verified,
          present: tierVerification.present,
          verified: tierVerification.verified,
        };
      }),
    },
    dataPath: app.getPath("userData"),
  };
}

async function collectDiagnostics(): Promise<Diagnostics> {
  return collectDiagnosticsForResolution(await currentModelResolution());
}

function rendererUrl(surface: RendererSurface): string {
  return rendererUrlForRuntime(
    surface,
    app.isPackaged,
    MAIN_WINDOW_VITE_DEV_SERVER_URL,
  );
}

function packagedRendererRoot(): string {
  return path.resolve(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`);
}

function installRendererProtocol(): void {
  const rendererRoot = packagedRendererRoot();
  protocol.handle(RENDERER_PROTOCOL_SCHEME, (request) => {
    const filePath = resolvePackagedRendererPath(request.url, rendererRoot);
    if (!filePath) {
      return new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

function commonWebPreferences() {
  return {
    preload: path.join(__dirname, "preload.js"),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    backgroundThrottling: false,
  } as const;
}

/** Which of this app's three renderers a webContents belongs to, if any. */
function surfaceForWebContents(contents: WebContents): RendererSurface | null {
  for (const [surface, window] of [
    ["pill", pillWindow],
    ["settings", settingsWindow],
    ["scratchpad", scratchpadWindow],
  ] as const) {
    if (window && !window.isDestroyed() && window.webContents.id === contents.id) return surface;
  }
  return null;
}

/**
 * Close Chromium's default grant-everything permission manager.
 *
 * Without this, every renderer — including the Scratchpad, which needs none of
 * them — is granted media, clipboard-read, notifications, openExternal,
 * pointerLock, midi and window-management on request. See
 * ./main/rendererPermissions for what each surface is allowed and why.
 */
function installPermissionHandlers(): void {
  const defaultSession = electronSession.defaultSession;
  defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(rendererPermissionRequestAllowed(
      surfaceForWebContents(contents),
      permission,
      {
        isMainFrame: details.isMainFrame,
        mediaTypes: "mediaTypes" in details ? details.mediaTypes : undefined,
      },
    ));
  });
  // The synchronous sibling. A handler on only one of the two leaves the other
  // answering from the default manager, which is the behaviour being replaced.
  defaultSession.setPermissionCheckHandler((contents, permission, _requestingOrigin, details) =>
    contents !== null && rendererPermissionCheckAllowed(
      surfaceForWebContents(contents),
      permission,
      { isMainFrame: details.isMainFrame, mediaType: details.mediaType },
    ),
  );
  // Screen and window capture is never part of dictation. Denying the request
  // outright is narrower than any permission answer, which only decides
  // whether the picker appears.
  defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => callback({}),
    { useSystemPicker: false },
  );
}

function hardenWindow(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
}

function windowForSurface(surface: RendererSurface): BrowserWindow | null {
  switch (surface) {
    case "pill": return pillWindow;
    case "settings": return settingsWindow;
    case "scratchpad": return scratchpadWindow;
  }
}

function assignSurfaceWindow(surface: RendererSurface, window: BrowserWindow | null): void {
  switch (surface) {
    case "pill": pillWindow = window; break;
    case "settings": settingsWindow = window; break;
    case "scratchpad": scratchpadWindow = window; break;
  }
}

type ReadyVisibility = "active" | "inactive" | "hidden";

function showWhenReady(window: BrowserWindow, visibility: ReadyVisibility): void {
  if (visibility === "hidden") return;
  window.once("ready-to-show", () => {
    if (window.isDestroyed()) return;
    if (visibility === "active") window.show();
    else window.showInactive();
  });
}

/**
 * Own renderer-process failures in main. A pill failure invalidates active
 * capture because the renderer owns microphone recording and final encoding;
 * the other surfaces are observational and must not cancel dictation.
 *
 * One automatic replacement is allowed per surface generation. The in-flight
 * latch is cleared only after a successful main-frame load, preventing a bad
 * bundle from creating an unbounded crash/reload loop.
 */
function installRendererFailureHandlers(window: BrowserWindow, surface: RendererSurface): void {
  const contents = window.webContents;
  contents.on("did-finish-load", () => {
    if (windowForSurface(surface) === window) rendererRecoveryInFlight.delete(surface);
  });

  const recover = (detail: "renderer_load_failed" | "renderer_process_gone") => {
    if (quitting || handledRendererFailures.has(contents)) return;
    const currentWindow = windowForSurface(surface);
    if (currentWindow !== null && currentWindow !== window) return;
    handledRendererFailures.add(contents);
    let wasVisible = false;
    try {
      wasVisible = !window.isDestroyed() && window.isVisible();
    } catch {
      // Teardown won the race. Hidden is the safe recovery default.
    }
    const policy = rendererFailureRecoveryPolicy({
      surface,
      quitting,
      hasActiveDictation: activeSessionId !== null,
      recoveryAlreadyInFlight: rendererRecoveryInFlight.has(surface),
      wasVisible,
    });
    diagnostics.record({
      stage: "lifecycle",
      event: "renderer_failure",
      outcome: "failed",
      detail,
      sessionId: activeSessionId ?? undefined,
    });
    if (windowForSurface(surface) === window) assignSurfaceWindow(surface, null);
    retiringRendererWindows.add(window);
    try {
      if (!window.isDestroyed()) window.destroy();
    } catch (error) {
      if (!quitting) console.warn(`LocalScribe could not retire its failed ${surface} window`, error);
    }
    if (policy.failActiveDictation) {
      failSession("The dictation display stopped unexpectedly. Try dictating again.");
    }
    if (!policy.recreate) return;
    rendererRecoveryInFlight.add(surface);
    queueMicrotask(() => {
      if (quitting) return;
      // A user action can create a new surface before this microtask runs.
      // Keep that newer generation instead of overwriting it with a duplicate.
      if (windowForSurface(surface) !== null) return;
      const visibility: ReadyVisibility = policy.restoreVisibleInactive ? "inactive" : "hidden";
      try {
        const replacement = surface === "pill"
          ? createPillWindow()
          : surface === "settings"
            ? createSettingsWindow(visibility)
            : createScratchpadWindow(visibility);
        assignSurfaceWindow(surface, replacement);
      } catch (error) {
        if (!quitting) console.warn(`LocalScribe could not recreate its ${surface} window`, error);
      }
    });
  };

  contents.on("did-fail-load", (_event, _code, _description, _url, isMainFrame) => {
    if (isMainFrame) recover("renderer_load_failed");
  });
  contents.on("render-process-gone", () => recover("renderer_process_gone"));
}

function hideWindowInsteadOfClosing(window: BrowserWindow): void {
  window.on("close", (event) => {
    if (quitting || retiringRendererWindows.has(window)) return;
    event.preventDefault();
    window.hide();
  });
}

/**
 * Tell a renderer when its native window is actually shown or hidden.
 *
 * `commonWebPreferences()` sets `backgroundThrottling: false` so dictation
 * timers stay accurate, but that also pins `document.visibilityState` to
 * "visible" and keeps intervals running at full rate in a hidden window
 * (verified in Electron 43). Closing a window only hides it, so a renderer
 * that tries to gate background work on the Page Visibility API never stops.
 * Main owns the real signal, so main sends it.
 */
function reportWindowVisibility(window: BrowserWindow): void {
  const send = (visible: boolean) => {
    sendToLiveRenderers([window], IPC.windowVisibility, visible, (error) => {
      if (!quitting) console.warn("LocalScribe could not report window visibility", error);
    });
  };
  window.on("show", () => send(true));
  window.on("restore", () => send(true));
  window.on("hide", () => send(false));
  window.on("minimize", () => send(false));
  window.webContents.on("did-finish-load", () => send(window.isVisible()));
}

function createSettingsWindow(readyVisibility: ReadyVisibility = "active"): BrowserWindow {
  const window = new BrowserWindow({
    width: SETTINGS_WINDOW_LAYOUT.defaultWidth,
    height: SETTINGS_WINDOW_LAYOUT.defaultHeight,
    minWidth: SETTINGS_WINDOW_LAYOUT.minimumWidth,
    minHeight: SETTINGS_WINDOW_LAYOUT.minimumHeight,
    title: "LocalScribe",
    show: false,
    backgroundColor: "#f3f1ed",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: commonWebPreferences(),
  });
  window.removeMenu();
  hideWindowInsteadOfClosing(window);
  reportWindowVisibility(window);
  hardenWindow(window);
  installRendererFailureHandlers(window, "settings");
  void window.loadURL(rendererUrl("settings"));
  showWhenReady(window, readyVisibility);
  window.on("closed", () => {
    if (settingsWindow === window) settingsWindow = null;
  });
  return window;
}

function createScratchpadWindow(readyVisibility: ReadyVisibility = "active"): BrowserWindow {
  const window = new BrowserWindow({
    width: 500,
    height: 430,
    minWidth: 420,
    minHeight: 340,
    maxWidth: 760,
    maxHeight: 860,
    title: "Scratchpad",
    show: false,
    backgroundColor: "#eeece7",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    alwaysOnTop: true,
    type: "panel",
    webPreferences: commonWebPreferences(),
  });
  window.removeMenu();
  hideWindowInsteadOfClosing(window);
  reportWindowVisibility(window);
  window.setWindowButtonVisibility(false);
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hardenWindow(window);
  installRendererFailureHandlers(window, "scratchpad");
  void window.loadURL(rendererUrl("scratchpad"));
  showWhenReady(window, readyVisibility);
  window.on("closed", () => {
    if (scratchpadWindow === window) scratchpadWindow = null;
  });
  return window;
}

function showScratchpad(): void {
  if (!scratchpadWindow || scratchpadWindow.isDestroyed()) {
    // A direct user action may retry after the one bounded automatic recovery.
    rendererRecoveryInFlight.delete("scratchpad");
    scratchpadWindow = createScratchpadWindow();
  }
  if (scratchpadWindow.isMinimized()) scratchpadWindow.restore();
  scratchpadWindow.show();
  scratchpadWindow.focus();
}

function showHub(target: NavigationTarget = "dictation"): void {
  if (target === "scratchpad") {
    showScratchpad();
    return;
  }
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    // A direct user action may retry after the one bounded automatic recovery.
    rendererRecoveryInFlight.delete("settings");
    settingsWindow = createSettingsWindow();
  }
  const sendTarget = () => settingsWindow?.webContents.send(IPC.windowNavigate, target);
  if (settingsWindow.webContents.isLoading()) settingsWindow.webContents.once("did-finish-load", sendTarget);
  else sendTarget();
  if (settingsWindow.isMinimized()) settingsWindow.restore();
  settingsWindow.show();
  settingsWindow.focus();
}

function positionPill(window: BrowserWindow): void {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const [width = PILL_LAYOUT.idle.collapsed.width, height = PILL_LAYOUT.idle.collapsed.height] = window.getSize();
  const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2);
  const y = Math.round(display.workArea.y + display.workArea.height - height - PILL_WINDOW_BOTTOM_MARGIN);
  const [currentX, currentY] = window.getPosition();
  if (currentX !== x || currentY !== y) window.setPosition(x, y, false);
}

function resizePill(): void {
  if (!pillWindow || pillWindow.isDestroyed()) return;
  const { width, height } = pillSizeFor(
    session.state,
    pillMode,
    session.activation,
    database.getSettings().asrMode,
  );
  const [currentWidth, currentHeight] = pillWindow.getSize();
  if (currentWidth !== width || currentHeight !== height) pillWindow.setSize(width, height, false);
  positionPill(pillWindow);
}

/** Where the pill window sits for a given size, without moving the window. */
function pillBoundsFor(size: { width: number; height: number }, cursor: Electron.Point): Electron.Rectangle {
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  return {
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + workArea.height - size.height - PILL_WINDOW_BOTTOM_MARGIN),
    width: size.width,
    height: size.height,
  };
}

function followPillHover(): void {
  if (!pillWindow || pillWindow.isDestroyed() || !pillWindow.isVisible()) return;
  if (session.state !== "idle") return;
  const cursor = screen.getCursorScreenPoint();
  // Only resize the transparent native surface here. The renderer still owns
  // when expanded controls become visible and hides them before contracting.
  const next = pillHoverModeForPointer({
    mode: pillMode,
    cursor,
    windowBounds: pillWindow.getBounds(),
    hoverBounds: pillBoundsFor(PILL_LAYOUT.idle.hover, cursor),
  });
  if (next === pillMode) return;
  pillMode = next;
  resizePill();
  /*
   * Tell the renderer what main just did. Resizing a window under a stationary
   * pointer does not synthesize pointerenter/pointerleave, so after main
   * contracts on its own — most visibly right after a microphone is chosen,
   * when the pointer is left where the 212px-tall picker used to be — the
   * renderer would otherwise keep the expanded controls mounted and clipped
   * inside a 40x8 window, with its own `pointerInside` still true.
   */
  sendToLiveRenderers([pillWindow], IPC.windowPillMode, pillMode, (error) => {
    if (!quitting) console.warn("LocalScribe could not synchronize dictation-display mode", error);
  });
}

function startPillDisplayFollowing(): void {
  if (pillDisplayTimer) return;
  pillDisplayTimer = setInterval(() => {
    try {
      if (pillWindow && !pillWindow.isDestroyed() && pillWindow.isVisible()) {
        positionPill(pillWindow);
        followPillHover();
      }
    } catch (error) {
      // The renderer-failure handler owns recreation. This timer must not turn
      // the teardown race into an uncaught main-process exception.
      if (!quitting) console.warn("LocalScribe could not follow the active display", error);
    }
  }, 75);
  pillDisplayTimer.unref();
}

function startAccessibilityUpgradeCheck(): void {
  if (process.platform !== "darwin" || accessibilityTimer) return;
  accessibilityTimer = setInterval(() => {
    if (!hotkeys) return;
    reconcileAccessibilityHotkeys(
      systemPreferences.isTrustedAccessibilityClient(false),
      hotkeys,
    );
  }, 2_000);
  accessibilityTimer.unref();
}

function createPillWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: PILL_LAYOUT.idle.collapsed.width,
    height: PILL_LAYOUT.idle.collapsed.height,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    roundedCorners: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    type: "panel",
    webPreferences: commonWebPreferences(),
  });
  window.setHasShadow(false);
  window.setAlwaysOnTop(true, "floating");
  hardenWindow(window);
  installRendererFailureHandlers(window, "pill");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setHiddenInMissionControl(true);
  void window.loadURL(rendererUrl("pill"));
  window.once("ready-to-show", () => {
    syncPillVisibility();
  });
  window.on("closed", () => {
    if (pillWindow === window) pillWindow = null;
  });
  return window;
}

function syncPillVisibility(): void {
  if (!pillWindow || pillWindow.isDestroyed()) return;
  const shouldShow = session.state !== "idle" || database.getSettings().showPillWhenIdle;
  if (shouldShow) {
    positionPill(pillWindow);
    pillWindow.showInactive();
  } else {
    pillWindow.hide();
  }
}

function setSession(next: SessionSnapshot): SessionSnapshot {
  const normalized = next.state === "error"
    ? { ...next, message: normalizeDictationErrorMessage(next.message) }
    : next;
  session = sessionSnapshotSchema.parse(normalized);
  if (session.state === "idle" || session.state === "success" || session.state === "error") {
    activeDictationTier = undefined;
    activeSessionId = null;
    activeSessionModelResolution = null;
    activeLiveSession = null;
  }
  // State observers are part of the transition itself. Arm/disarm them before
  // any native-menu, window, or renderer notification that can race teardown
  // or throw, otherwise a dead renderer can leave `finalizing` wedged forever.
  finalizeWatchdog.observe(session);
  noticeTimer.observe(session);
  if (session.state !== "idle") pillMode = "collapsed";
  try {
    resizePill();
  } catch (error) {
    if (!quitting) console.warn("LocalScribe could not resize its dictation display", error);
  }
  refreshNativeMenus();
  sendToLiveRenderers(
    [pillWindow, settingsWindow, scratchpadWindow],
    IPC.sessionChanged,
    session,
    (error) => {
      if (!quitting) console.warn("LocalScribe could not deliver a session update to one window", error);
    },
  );
  try {
    syncPillVisibility();
  } catch (error) {
    if (!quitting) console.warn("LocalScribe could not refresh dictation-display visibility", error);
  }
  return session;
}

function failSession(error: unknown): SessionSnapshot {
  const live = activeLiveSession;
  activeLiveSession = null;
  if (live) scheduleLiveWorkerCancellation(live.sessionId);
  insertion.cancelSession();
  return setSession({ state: "error", message: normalizeDictationErrorMessage(error) });
}

/**
 * Invalidate the renderer-facing session before waiting on a queued append.
 * The supervisor clears its own Live token synchronously, so any late partial
 * or final response is rejected; worker cleanup can then serialize behind the
 * in-flight request without holding the pill in Listening state.
 */
function scheduleLiveWorkerCancellation(sessionId: string): void {
  void worker.cancelLiveSession(sessionId).catch((error) => {
    if (!quitting) console.warn("LocalScribe could not finish Live worker cleanup", error);
  });
}


function notifyHistoryChanged(): void {
  sendToLiveRenderers([settingsWindow], IPC.historyChanged, undefined, (error) => {
    // The durable write already happened. A renderer closing between this
    // predicate and send must not turn a completed dictation into a failure.
    console.warn("LocalScribe could not refresh history after saving", error);
  });
}

/** Rebuild the macOS My Voice counts after a successful Dictionary/Snippet mutation. */
function refreshVoiceMenuAfterLibraryMutation(): void {
  try {
    installApplicationMenu();
  } catch (error) {
    // The mutation is durable; a later session transition will retry the menu
    // rebuild, so a transient native-menu error must not reject the IPC call.
    console.warn("LocalScribe could not refresh its My Voice menu", error);
  }
}

/** Deliver a validated install/repair event only to the model-management UI. */
function notifyModelInstallProgress(progress: ModelInstallProgress): void {
  sendToLiveRenderers([settingsWindow], IPC.systemModelInstallProgress, progress, (error) => {
    // Progress delivery is observational. A hidden or torn-down settings
    // window must not interrupt a verified disk transaction.
    console.warn("LocalScribe could not deliver model-install progress", error);
  });
}

/** Send only ordered, current-session Live snapshots to the pill preview. */
function notifyLivePartial(partial: LivePartialTranscript): void {
  const live = activeLiveSession;
  if (
    !live
    || live.sessionId !== partial.sessionId
    || session.state !== "listening"
    || session.sessionId !== partial.sessionId
    || activeSessionId !== partial.sessionId
    || !pillWindow
  ) return;
  sendToLiveRenderers([pillWindow], IPC.sessionLivePartial, partial, (error) => {
    // Provisional rendering never owns the dictation transaction. A destroyed
    // or reloading pill must not affect capture or final insertion.
    console.warn("LocalScribe could not deliver a Live transcript preview", error);
  });
}

/** Broadcast only validated, persisted settings after a successful save. */
function notifySettingsChanged(settings: ReturnType<LocalDatabase["getSettings"]>): void {
  sendToLiveRenderers(
    [pillWindow, settingsWindow, scratchpadWindow],
    IPC.settingsChanged,
    settings,
    (error) => console.warn(
      "LocalScribe could not deliver a persisted settings update to one window",
      error,
    ),
  );
}

function beginListening(activation: "hold" | "toggle" = "toggle"): SessionSnapshot {
  if (session.state !== "idle" && session.state !== "success" && session.state !== "error") return session;
  if (modelOperationInProgress()) {
    return failSession("Wait for the local model operation to finish before dictating.");
  }
  const settings = database.getSettings();
  try {
    void workerLanguageForActiveModel(settings);
  } catch (error) {
    return failSession(error);
  }
  const preference = settings.modelPerformanceMode;
  if (preference !== "auto") {
    if (!modelResolution) {
      return failSession("Local model selection is still initializing. Try dictating again in a moment.");
    }
    try {
      assertResolutionFitsMemory(modelResolution);
    } catch (error) {
      return failSession(error);
    }
  }
  const sessionId = randomUUID();
  activeSessionId = sessionId;
  if (preference === "auto") {
    // Sample live memory at every recording boundary without evicting a warm
    // model. Selection policy adds back the warm tier's curated minimum
    // allocation, so Auto compares tiers against a conservative
    // unloaded-equivalent budget.
    // A changed tier is applied later by the normal same-family transcription
    // load boundary; Auto never falls back to another family.
    const promise = refreshAutoResolutionAtRecordingBoundary().then((resolution) => {
      if (activeSessionId === sessionId) {
        activeDictationTier = resolution.effectiveTier;
      }
      return resolution;
    });
    // A cancelled recording may never submit audio. Attach a rejection
    // observer now so a failed hardware probe cannot become unhandled.
    void promise.catch(() => undefined);
    activeSessionModelResolution = { sessionId, promise };
  } else {
    activeDictationTier = modelResolution!.effectiveTier;
    activeSessionModelResolution = {
      sessionId,
      promise: Promise.resolve(modelResolution!),
    };
  }
  insertion.beginSession();
  positionPill(pillWindow!);
  pillWindow?.showInactive();
  diagnostics.record({
    stage: "session",
    event: "begin_listening",
    outcome: "ok",
    sessionId,
    hotkeyMode: activation,
    modelFamily: database.getSettings().activeModelFamilyId,
    modelTier: activeDictationTier ?? undefined,
  });
  return setSession({
    state: "listening",
    sessionId,
    startedAt: Date.now(),
    message: "Listening",
    activation,
  });
}

function finishListening(): SessionSnapshot {
  if (session.state !== "listening") return session;
  return setSession({
    state: "finalizing",
    sessionId: session.sessionId,
    message: "Finishing recording",
  });
}

function assertActiveSession(sessionId: string): void {
  if (activeSessionId !== sessionId) {
    throw new Error("Dictation was cancelled");
  }
}

/** The sole final-result path for both After I stop and Live dictation. */
async function completeDictationFinal(input: {
  sessionId: string;
  durationMs: number;
  settings: ReturnType<LocalDatabase["getSettings"]>;
  resolution: ModelPerformanceResolution;
  result: { text: string; language: string | null };
}): Promise<ReturnType<LocalDatabase["saveTranscription"]>> {
  const { sessionId, durationMs, settings, resolution, result } = input;
  const concreteModel = resolution.tier.manifest;
  const dictionary = database.listDictionary();
  const targetAppId = await insertion.targetAppId();
  const persistedSourceAppId = sanitizeSourceApplicationId(targetAppId);
  assertActiveSession(sessionId);
  const profile = database.findProfile(targetAppId);
  const cleanup = {
    removeFillers: profile?.removeFillers ?? settings.removeFillers,
    spokenCommands: profile?.spokenCommands ?? settings.spokenCommands,
    smartPunctuation: profile?.smartPunctuation ?? settings.smartPunctuation,
  };
  const transformed = transformDictation(result.text, {
    fillerMode: cleanup.removeFillers ? "conservative" : "off",
    punctuationCommands: cleanup.spokenCommands,
    paragraphCommands: cleanup.spokenCommands,
    scratchCommands: cleanup.spokenCommands,
    capitalizeSentences: cleanup.smartPunctuation,
    terminalPunctuation: cleanup.smartPunctuation ? "ensure" : "preserve",
    normalizeWhitespace: cleanup.smartPunctuation,
  });
  const text = applyLocalTextRules(
    transformed.text,
    dictionary,
    database.listSnippets(),
    { normalizeSpacing: cleanup.smartPunctuation },
  );
  if (!text.trim()) throw new Error("No speech detected");
  let successMessage: string;
  if (settingsWindow?.isFocused() || scratchpadWindow?.isFocused()) {
    const insertionResult = await insertion.copyAndPasteDetailed(text, false);
    const { outcome } = insertionResult;
    assertActiveSession(sessionId);
    diagnostics.record({ ...insertionDiagnosticEvent(insertionResult, false, false), sessionId });
    successMessage = outcome === "copied" ? "Copied to clipboard" : "Inserted";
  } else {
    const automaticPasteReady = await insertion.automaticPasteReady();
    const canAutoPaste = settings.autoPaste && automaticPasteReady;
    setSession({ state: "inserting", sessionId, message: canAutoPaste ? "Inserting" : "Copying" });
    const insertionResult = await insertion.copyAndPasteDetailed(text, canAutoPaste);
    const { outcome } = insertionResult;
    assertActiveSession(sessionId);
    diagnostics.record({
      ...insertionDiagnosticEvent(insertionResult, settings.autoPaste, automaticPasteReady),
      sessionId,
    });
    const copiedMessage = settings.autoPaste && !automaticPasteReady
      ? "Copied — allow Accessibility"
      : "Copied to clipboard";
    successMessage = outcome === "pasted"
      ? "Inserted"
      : outcome === "pasted-with-copy"
        ? "Paste sent · copied as backup"
        : copiedMessage;
  }
  // Insertion/copy is the completion boundary. History follows it as a
  // best-effort local convenience, never as a reason to reclassify an already
  // delivered dictation as a transcription failure.
  setSession({ state: "success", sessionId, message: successMessage });
  const history = persistCompletedDictationHistory(settings.keepHistory, {
    transientRecord: () => ({
      id: randomUUID(),
      createdAt: Date.now(),
      durationMs,
      text,
      language: result.language,
      modelId: concreteModel.modelId,
      status: "complete" as const,
      sourceAppId: persistedSourceAppId,
    }),
    save: () => database.saveTranscription({
      durationMs,
      text,
      language: result.language,
      modelId: concreteModel.modelId,
      status: "complete",
      sourceAppId: persistedSourceAppId,
    }),
    purgeExpired: () => database.purgeExpiredTranscriptions(settings.historyRetentionDays),
    notifyChanged: notifyHistoryChanged,
    recordFailure: (event, error) => diagnostics.record({
      stage: "lifecycle",
      event,
      outcome: "failed",
      sessionId,
      durationMs,
      detail: normalizeDiagnosticCode(error),
    }),
  });
  if (history.warning) {
    setSession({ state: "success", sessionId, message: history.warning });
  }
  return history.record;
}

function trustedSurfaceForEvent(event: IpcMainInvokeEvent): RendererSurface {
  if (quitting) throw new Error("LocalScribe is shutting down");
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) {
    throw new Error("Rejected IPC outside a live main renderer frame");
  }
  const candidates: Array<[RendererSurface, BrowserWindow | null]> = [
    ["settings", settingsWindow],
    ["pill", pillWindow],
    ["scratchpad", scratchpadWindow],
  ];
  for (const [surface, window] of candidates) {
    if (!window || window.isDestroyed() || window.webContents !== event.sender) continue;
    const expectedUrl = rendererUrl(surface);
    if (frame.url !== expectedUrl || event.sender.getURL() !== expectedUrl) {
      throw new Error("Rejected IPC from an unexpected renderer URL");
    }
    return surface;
  }
  throw new Error("Rejected IPC from a renderer that is not owned by a live LocalScribe window");
}

async function applyModelSelection(
  request: ReturnType<typeof modelSelectionApplyRequestSchema.parse>,
): Promise<ModelSelectionApplyResult> {
  return runExclusiveModelOperation(async () => {
    assertModelSwitchAllowed();
    const targetCatalog = assertModelSelectionSupported(platformModelCatalog(), {
      familyId: request.familyId,
      asrMode: request.asrMode,
      preference: request.performanceMode,
    });
    assertFamilyInLibrary(request.familyId);

    const previousSettings = database.getSettings();
    // Do not silently rewrite a saved language when a narrow model is applied.
    // The renderer keeps the saved choice visible and receives this actionable
    // preflight error, while the existing applied model stays available.
    assertModelLanguageSupported(
      previousSettings.language,
      targetCatalog.capabilities,
      targetCatalog.displayName,
    );
    const samePersistedSelection = (
      previousSettings.activeModelFamilyId === request.familyId
      && previousSettings.asrMode === request.asrMode
      && previousSettings.modelPerformanceMode === request.performanceMode
    );
    const currentResolutionForSelection = samePersistedSelection
      ? await currentModelResolution()
      : null;
    const currentWarmSelection = worker.loadedSelection();
    if (
      currentResolutionForSelection
      && currentResolutionForSelection.fitsMemoryBudget
      && workerModelSelectionsMatch(
        currentWarmSelection,
        workerSelection(currentResolutionForSelection.tier, request.asrMode),
      )
    ) {
      // Apply is a no-op only when the exact resolved runtime is already warm.
      const [catalog, diagnostics] = await Promise.all([
        collectModelCatalogForSettings(previousSettings),
        collectDiagnosticsForResolution(currentResolutionForSelection),
      ]);
      return {
        applied: true,
        appliedSelection: {
          familyId: currentResolutionForSelection.tier.familyId,
          artifactId: currentResolutionForSelection.tier.artifactId,
          tier: currentResolutionForSelection.effectiveTier,
          asrMode: request.asrMode,
        },
        settings: previousSettings,
        catalog,
        diagnostics,
      };
    }

    const previousResolution = currentResolutionForSelection ?? modelResolution
      ?? resolveSelection(
        previousSettings.activeModelFamilyId,
        previousSettings.modelPerformanceMode,
      );
    const previousWarmSelection = currentWarmSelection;
    const previousAutoTierSnapshot = previousAutoTier;
    const previousAcceleratorSnapshot = acceleratorSnapshot;
    const candidateSettings = appSettingsSchema.parse({
      ...previousSettings,
      activeModelFamilyId: request.familyId,
      asrMode: request.asrMode,
      modelPerformanceMode: request.performanceMode,
    });
    let targetResolution: ModelPerformanceResolution;
    let runtimeTransitionStarted = false;

    try {
      /*
       * Resolve and verify the exact replacement while the working model is
       * still resident. The memory projection adds back only the curated
       * minimum allocation of that warm model, so it cannot overstate the
       * budget. This closes the destructive gap where Apply used to kill a
       * usable runtime and only then discover that the selected artifact was
       * missing or corrupt.
       */
      if (!acceleratorSnapshot) {
        if (currentWarmSelection) acceleratorSnapshot = await worker.deviceInfo();
        else await probeUnloadedAccelerator();
      }
      const warmResolutionMatches = currentWarmSelection !== null
        && workerModelSelectionsMatch(
          currentWarmSelection,
          workerSelection(previousResolution.tier, previousSettings.asrMode),
        );
      const projectedMemory = warmResolutionMatches && acceleratorSnapshot
        ? memorySnapshotWithoutWarmModel(acceleratorSnapshot, previousResolution)
        : memorySnapshot();
      targetResolution = resolveModelPerformance({
        preference: request.performanceMode,
        catalog: targetCatalog,
        memory: projectedMemory,
        previousTier: previousSettings.activeModelFamilyId === request.familyId
          && previousSettings.modelPerformanceMode === "auto"
          ? previousAutoTier
          : undefined,
      });
      assertResolutionFitsMemory(targetResolution);

      const modelRoot = modelRootForUserData(app.getPath("userData"));
      // Only the artifact about to be loaded gates the Apply. Verifying the whole
      // family here also hashed the tiers the user is switching away from —
      // gigabytes of reads that could not change the outcome.
      const targetVerification = await verifyModelDirectory(modelRoot, targetResolution.tier.manifest);
      if (!targetVerification.verified || targetVerification.verificationStatus !== "verified") {
        const action = targetVerification.present ? "repair" : "install";
        throw new Error(
          `The selected local speech model is not cryptographically verified. ${action === "repair" ? "Repair" : "Install"} this exact model and quality tier before applying it.`,
        );
      }

      // From here onward the rollback path owns the worker lifecycle. Errors
      // above this line are pure preflight failures and must leave an existing
      // warm model entirely untouched.
      runtimeTransitionStarted = true;
      await worker.shutdown();
      await probeUnloadedAccelerator();
      const postUnloadFit = resolveModelPerformance({
        preference: targetResolution.effectiveTier,
        catalog: targetCatalog,
        memory: memorySnapshot(),
      });
      assertResolutionFitsMemory(postUnloadFit);
      previousAutoTier = undefined;

      // Eager loading proves the exact engine, model, quantization, and current
      // memory state before either routing field becomes durable.
      await worker.ensureReady(workerSelection(targetResolution.tier, request.asrMode));

      const [catalog, diagnostics] = await Promise.all([
        collectModelCatalogForSettings(candidateSettings),
        collectDiagnosticsForResolution(targetResolution, request.asrMode),
      ]);
      // Loading and catalog verification can take minutes. Merge the two model
      // routing fields into the latest row immediately before the synchronous
      // write so a microphone, shortcut, launch-at-login, or other settings
      // update committed while Apply was running cannot be reverted here.
      // There must be no await between this read and write.
      const latestSettings = database.getSettings();
      assertModelLanguageSupported(
        latestSettings.language,
        targetCatalog.capabilities,
        targetCatalog.displayName,
      );
      const settings = database.saveSettings(appSettingsSchema.parse({
        ...latestSettings,
        activeModelFamilyId: request.familyId,
        asrMode: request.asrMode,
        modelPerformanceMode: request.performanceMode,
      }));
      modelResolution = targetResolution;
      if (request.performanceMode === "auto" && targetResolution.fitsMemoryBudget) {
        previousAutoTier = targetResolution.effectiveTier;
      }
      notifySettingsChanged(settings);
      return {
        applied: true,
        appliedSelection: {
          familyId: targetResolution.tier.familyId,
          artifactId: targetResolution.tier.artifactId,
          tier: targetResolution.effectiveTier,
          asrMode: request.asrMode,
        },
        settings,
        catalog,
        diagnostics,
      };
    } catch (error) {
      // Target load and durable settings are one transaction from the user's
      // perspective. A failed target is always terminated, and the previous
      // warm selection is restored best-effort without altering its settings.
      let restoreError: unknown = null;
      let restoreSkippedForShutdown = false;
      if (runtimeTransitionStarted) {
        try {
          await worker.shutdown();
          if (previousWarmSelection) {
            if (quitting) restoreSkippedForShutdown = true;
            else await worker.ensureReady(previousWarmSelection);
          }
        } catch (rollbackError) {
          restoreError = rollbackError;
        }
      }
      acceleratorSnapshot = previousAcceleratorSnapshot;
      previousAutoTier = previousAutoTierSnapshot;
      modelResolution = previousResolution;
      const reason = error instanceof Error ? error.message : "The target model could not be loaded.";
      const restoreDetail = restoreError
        ? " The previous model settings were kept, but its warm runtime could not be restored; the next dictation will retry loading it."
        : restoreSkippedForShutdown
          ? " The previous model settings were kept; its runtime was not restarted because LocalScribe is shutting down."
        : previousWarmSelection && !runtimeTransitionStarted
          ? " The previous model was never unloaded and its settings remain active."
        : previousWarmSelection
          ? " The previous model was restored and its settings remain active."
          : " The previous settings remain active; no model was warm before Apply.";
      throw new Error(`Could not apply the local speech model: ${reason}${restoreDetail}`, {
        cause: error,
      });
    }
  });
}

function registerIpc(): void {
  const handle = <T extends unknown[]>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: T) => unknown,
  ) => {
    ipcMain.handle(channel, (event, ...args: T) => {
      const surface = trustedSurfaceForEvent(event);
      assertRendererSurfaceCanInvoke(surface, channel);
      return handler(event, ...args);
    });
  };

  handle(IPC.sessionGet, () => session);
  handle(IPC.sessionToggle, () => (session.state === "listening" ? finishListening() : beginListening("toggle")));
  handle(IPC.sessionCancel, async () => {
    const live = activeLiveSession;
    activeLiveSession = null;
    if (live) scheduleLiveWorkerCancellation(live.sessionId);
    insertion.cancelSession();
    activeSessionId = null;
    /*
     * `abort()` kills the worker process — the unload guarantee — so it costs a
     * multi-gigabyte model reload on the next dictation. Only "transcribing"
     * has a transcribe request actually in flight: in "finalizing" the renderer
     * is still encoding WAV audio and nothing has been sent, and in "inserting"
     * the worker already returned its final result. Cancelling from either of
     * those was discarding a warm model for nothing, against the invariant that
     * an applied model stays warm between dictations. The session teardown
     * above is what those states actually need.
     */
    if (session.state === "transcribing") {
      worker.abort("Dictation was cancelled");
    }
    return setSession({ state: "idle" });
  });
  handle(IPC.sessionFail, (_event, rawFailure: unknown) => {
    const failure = sessionFailureSchema.parse(rawFailure);
    if (
      activeSessionId !== failure.sessionId
      || session.sessionId !== failure.sessionId
    ) return session;
    return failSession(failure.message);
  });

  handle(IPC.sessionBeginLive, async (_event, rawSession: unknown) => {
    const request = liveAudioSessionSchema.parse(rawSession);
    if (
      session.state !== "listening"
      || session.sessionId !== request.sessionId
      || activeSessionId !== request.sessionId
      || activeLiveSession !== null
    ) {
      throw new Error("Live dictation was cancelled");
    }
    const settings = database.getSettings();
    if (settings.asrMode !== "live") {
      throw new Error("Live dictation is not selected in LocalScribe settings.");
    }
    let workerLanguage: string;
    try {
      workerLanguage = workerLanguageForActiveModel(settings);
    } catch (error) {
      failSession(error);
      throw error;
    }
    // Catalog capability is necessary but not sufficient; `beginLive` below
    // is the runtime-adapter proof and fails closed when the helper is absent.
    assertModelSelectionSupported(platformModelCatalog(), {
      familyId: settings.activeModelFamilyId,
      asrMode: "live",
      preference: settings.modelPerformanceMode,
    });
    const resolution = await currentModelResolution();
    assertResolutionFitsMemory(resolution);
    const sink = await worker.beginLive({
      session: request,
      model: workerSelection(resolution.tier, "live"),
      language: workerLanguage,
      // Live Parakeet does not accept ASR prompt context. Dictionary and
      // snippet expansion still run on its final result in the shared path.
      context: "",
      onPartial: notifyLivePartial,
    });
    if (
      session.state !== "listening"
      || session.sessionId !== request.sessionId
      || activeSessionId !== request.sessionId
    ) {
      await sink.abort?.(new Error("Live dictation was cancelled"));
      throw new Error("Live dictation was cancelled");
    }
    activeLiveSession = {
      sessionId: request.sessionId,
      sink,
      resolution,
      startedAt: Date.now(),
    };
  });

  handle(IPC.sessionPushLive, async (_event, rawFrame: unknown) => {
    const frame = liveAudioFrameSchema.parse(rawFrame);
    const live = activeLiveSession;
    if (
      !live
      || live.sessionId !== frame.sessionId
      || session.state !== "listening"
      || session.sessionId !== frame.sessionId
      || activeSessionId !== frame.sessionId
    ) {
      throw new Error("Live dictation was cancelled");
    }
    await live.sink.write(frame, new AbortController().signal);
  });

  handle(IPC.sessionFinishLive, async (_event, rawRequest: unknown) => {
    const request = finishLiveAudioSchema.parse(rawRequest);
    const live = activeLiveSession;
    if (
      !live
      || live.sessionId !== request.sessionId
      || session.state !== "finalizing"
      || session.sessionId !== request.sessionId
      || activeSessionId !== request.sessionId
    ) {
      throw new Error("Live dictation was cancelled");
    }
    try {
      setSession({ state: "transcribing", sessionId: request.sessionId, message: "Finishing Live dictation" });
      const result = await worker.finishLiveWithResult(request.sessionId);
      assertActiveSession(request.sessionId);
      activeLiveSession = null;
      const record = await completeDictationFinal({
        sessionId: request.sessionId,
        durationMs: Math.max(1, Date.now() - live.startedAt),
        settings: database.getSettings(),
        resolution: live.resolution,
        result,
      });
      diagnostics.record({
        stage: "worker",
        event: "transcribe",
        outcome: "ok",
        sessionId: request.sessionId,
        durationMs: Math.max(1, Date.now() - live.startedAt),
        modelFamily: database.getSettings().activeModelFamilyId,
        modelTier: live.resolution.effectiveTier,
      });
      return record;
    } catch (error) {
      if (activeSessionId === request.sessionId) failSession(error);
      diagnostics.record({
        stage: "worker",
        event: "transcribe",
        outcome: "failed",
        sessionId: request.sessionId,
        durationMs: Math.max(1, Date.now() - live.startedAt),
        detail: normalizeDiagnosticCode(error),
        modelFamily: database.getSettings().activeModelFamilyId,
        modelTier: live.resolution.effectiveTier,
      });
      throw error;
    } finally {
      if (activeLiveSession?.sessionId === request.sessionId) activeLiveSession = null;
    }
  });

  handle(IPC.sessionCancelLive, async (_event, rawRequest: unknown) => {
    const request = cancelLiveAudioSchema.parse(rawRequest);
    const live = activeLiveSession;
    if (!live || live.sessionId !== request.sessionId) {
      throw new Error("Live dictation was cancelled");
    }
    activeLiveSession = null;
    // Do not await this cleanup: it serializes behind an append request that
    // may still be executing inside the worker. The local session becomes
    // idle first, blocking late partials/finals and immediately releasing the
    // recorder UI; the worker receives cancel as soon as the append exits.
    scheduleLiveWorkerCancellation(request.sessionId);
    insertion.cancelSession();
    activeSessionId = null;
    return setSession({ state: "idle" });
  });

  handle(IPC.sessionTranscribe, async (_event, rawInput: unknown) => {
    /*
     * The renderer deliberately swallows this channel's rejection — main owns
     * transcription failures — so anything that throws before the "transcribing"
     * transition has to surface the failure itself. That whole stretch lives in
     * `prepareTranscription` so its ordering guarantees can be tested with
     * injected write and remove failures rather than asserted from source text.
     */
    const { input, settings, cacheRoot, audioPath } = await prepareTranscription(rawInput, {
      parse: (raw) => transcribeAudioSchema.parse(raw),
      admits: (sessionId) => transcribeAudioAdmission({
        activeSessionId,
        sessionState: session.state,
        snapshotSessionId: session.sessionId,
        sessionId,
      }) === "accept",
      isFinalizing: () => session.state === "finalizing",
      readSettings: () => database.getSettings(),
      audioCacheRoot: () => audioCacheRoot,
      newAudioPath: (root) => path.join(root, `${randomUUID()}.wav`),
      writeAudio: async (target, wav) => {
        await writeFile(target, new Uint8Array(wav), { mode: 0o600, flag: "wx" });
      },
      removeAudio: (target) => rm(target, { force: true }),
      failSession,
      record: (event) => diagnostics.record(event),
      errorCode: normalizeDiagnosticCode,
    });
    setSession({
      state: "transcribing",
      sessionId: input.sessionId,
      message: "Transcribing locally",
    });
    try {
      if (settings.asrMode !== "after-stop") {
        throw new Error("Live dictation must use the local Live audio session.");
      }
      const workerLanguage = workerLanguageForActiveModel(settings);
      const resolution = await currentModelResolution();
      assertResolutionFitsMemory(resolution);
      const terms = dictionaryAsrContextForCapabilities(
        database.listDictionary(),
        modelCatalog(resolution.tier.familyId).capabilities,
      );
      const result = await worker.transcribe({
        model: workerSelection(resolution.tier, settings.asrMode),
        audioPath,
        allowedRoot: cacheRoot,
        language: workerLanguage,
        context: terms,
        durationMs: input.durationMs,
      });
      assertActiveSession(input.sessionId);
      const record = await completeDictationFinal({
        sessionId: input.sessionId,
        durationMs: input.durationMs,
        settings,
        resolution,
        result,
      });
      diagnostics.record({
        stage: "worker",
        event: "transcribe",
        outcome: "ok",
        sessionId: input.sessionId,
        durationMs: input.durationMs,
        modelFamily: settings.activeModelFamilyId,
        modelTier: resolution.effectiveTier,
      });
      // The return to idle is armed by `setSession` on entry to success, so
      // nothing between there and here can leave the session stranded.
      return record;
    } catch (error) {
      if (activeSessionId === input.sessionId) failSession(error);
      diagnostics.record({
        stage: "worker",
        event: "transcribe",
        outcome: "failed",
        sessionId: input.sessionId,
        durationMs: input.durationMs,
        detail: normalizeDiagnosticCode(error),
      });
      throw error;
    } finally {
      // Never `await rm` directly here: this `finally` runs on the success path
      // too, and a rejecting cleanup would reject an IPC call whose dictation
      // had already been inserted and persisted.
      await discardAudio(audioPath, {
        removeAudio: (target) => rm(target, { force: true }),
        record: (event) => diagnostics.record(event),
        errorCode: normalizeDiagnosticCode,
      }, input.sessionId);
    }
  });

  handle(IPC.historyList, (_event, limit?: unknown) =>
    database.listTranscriptionsWithIntegrity(limitSchema.parse(limit)),
  );
  handle(IPC.historyDelete, (_event, id: unknown) => {
    database.deleteTranscription(uuidSchema.parse(id));
    notifyHistoryChanged();
  });
  handle(IPC.historyClear, () => {
    database.clearTranscriptions();
    notifyHistoryChanged();
  });
  handle(IPC.historyExport, async () => {
    const options = {
      title: "Export LocalScribe history",
      defaultPath: `LocalScribe-history-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    };
    const result = settingsWindow
      ? await dialog.showSaveDialog(settingsWindow, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    /*
     * An export that silently omits records is worse than one that fails: the
     * user keeps the file and believes it is their complete history. Records
     * this install can no longer decrypt are still skipped — they cannot be
     * written — but the file says so, at the top level, where anything reading
     * it will see it.
     */
    const exported = database.exportTranscriptionsWithIntegrity();
    if (!exported.complete) {
      diagnostics.record({
        stage: "lifecycle",
        event: "history_export_partial",
        outcome: "failed",
        count: exported.skippedUnreadable,
      });
    }
    const payload = {
      exportedAt: new Date().toISOString(),
      complete: exported.complete,
      skippedUnreadableRecords: exported.skippedUnreadable,
      ...(exported.complete
        ? {}
        : {
          note:
            "Some records could not be decrypted on this machine and are not included. "
            + "They remain in the database and may be readable again once the original "
            + "system keystore entry is available.",
        }),
      transcriptions: exported.transcriptions,
    };
    // Every transcript in this file is decrypted plaintext, so it is written
    // through the helper that tightens an existing target's permissions rather
    // than inheriting them. See ./main/persistence/privateFile.
    await writePrivateFile(result.filePath, `${JSON.stringify(payload, null, 2)}\n`);
    return result.filePath;
  });

  handle(IPC.dictionaryList, () => database.listDictionary());
  handle(IPC.dictionarySave, (_event, input: unknown) => {
    const entry = database.saveDictionary(dictionaryInputSchema.parse(input));
    refreshVoiceMenuAfterLibraryMutation();
    return entry;
  });
  handle(IPC.dictionaryDelete, (_event, id: unknown) => {
    database.deleteDictionary(uuidSchema.parse(id));
    refreshVoiceMenuAfterLibraryMutation();
  });

  handle(IPC.snippetsList, () => database.listSnippets());
  handle(IPC.snippetsSave, (_event, input: unknown) => {
    const snippet = database.saveSnippet(snippetInputSchema.parse(input));
    refreshVoiceMenuAfterLibraryMutation();
    return snippet;
  });
  handle(IPC.snippetsDelete, (_event, id: unknown) => {
    database.deleteSnippet(uuidSchema.parse(id));
    refreshVoiceMenuAfterLibraryMutation();
  });

  handle(IPC.profilesList, () => database.listProfiles());
  handle(IPC.profilesSave, (_event, input: unknown) =>
    database.saveProfile(profileInputSchema.parse(input)),
  );
  handle(IPC.profilesDelete, (_event, id: unknown) => database.deleteProfile(uuidSchema.parse(id)));
  handle(IPC.scratchpadList, () => database.listScratchpadNotesWithIntegrity());
  handle(IPC.scratchpadCreate, () => database.createScratchpadNote());
  handle(IPC.scratchpadUpdate, (_event, id: unknown, body: unknown) =>
    database.updateScratchpadNote(uuidSchema.parse(id), scratchpadSchema.parse(body)),
  );
  handle(IPC.scratchpadDelete, (_event, id: unknown) =>
    database.deleteScratchpadNote(uuidSchema.parse(id)),
  );

  handle(IPC.settingsGet, () => database.getSettings());
  handle(IPC.settingsPatch, async (_event, input: unknown) => {
    const patch = appSettingsPatchSchema.parse(input);
    if (
      trustedSurfaceForEvent(_event) === "pill"
      && Object.keys(patch).some((key) => key !== "microphoneId")
    ) {
      throw new Error("The pill may update only its selected microphone.");
    }
    const previous = database.getSettings();
    const preview = appSettingsSchema.parse({ ...previous, ...patch });
    const launchAtLoginRequested = Object.prototype.hasOwnProperty.call(patch, "launchAtLogin");
    if (launchAtLoginRequested) {
      app.setLoginItemSettings(loginItemSettings(preview.launchAtLogin));
    }
    let settings: ReturnType<LocalDatabase["getSettings"]>;
    try {
      settings = applySettingsPatchTransaction({ database, hotkeys }, patch);
    } catch (error) {
      if (launchAtLoginRequested) {
        try {
          app.setLoginItemSettings(loginItemSettings(previous.launchAtLogin));
        } catch (rollbackError) {
          console.error("Could not restore the previous login startup setting", rollbackError);
        }
      }
      throw error;
    }
    try {
      const purged = database.purgeExpiredTranscriptions(settings.historyRetentionDays);
      if (purged > 0) notifyHistoryChanged();
    } catch (error) {
      console.warn("LocalScribe could not apply transcript retention immediately after saving", error);
    }
    try {
      syncPillVisibility();
    } catch (error) {
      console.warn("LocalScribe could not refresh floating-bar visibility after saving", error);
    }
    try {
      installApplicationMenu();
    } catch (error) {
      console.warn("LocalScribe could not refresh its menu after saving", error);
    }
    notifySettingsChanged(settings);
    return settings;
  });
  handle(IPC.shortcutsBeginCapture, () => hotkeys.beginCapture());
  handle(IPC.shortcutsEndCapture, () => hotkeys.endCapture());
  handle(IPC.shortcutsValidate, (_event, input: unknown) =>
    hotkeys.validateShortcut(shortcutValidationRequestSchema.parse(input)),
  );
  handle(IPC.shortcutsUpdate, (_event, input: unknown) => {
    const settings = applyShortcutUpdateTransaction({ database, hotkeys }, input);
    // The transaction only returns after the new hotkeys are active and the
    // settings row is durable. Every surface receives that same value now.
    notifySettingsChanged(settings);
    try {
      installApplicationMenu();
    } catch (error) {
      console.warn("LocalScribe could not refresh its menu after saving a shortcut", error);
    }
    return settings;
  });
  handle(IPC.windowShowSettings, (_event, rawTarget: unknown) => {
    showHub(rawTarget === undefined ? "dictation" : navigationTargetSchema.parse(rawTarget));
  });
  handle(IPC.windowSetPillMode, (_event, mode: unknown) => {
    pillMode = pillModeSchema.parse(mode);
    if (session.state === "idle") resizePill();
  });
  handle(IPC.windowCloseScratchpad, () => scratchpadWindow?.close());
  handle(IPC.windowToggleScratchpadSize, () => {
    if (!scratchpadWindow || scratchpadWindow.isDestroyed()) return;
    if (scratchpadWindow.isMaximized()) scratchpadWindow.unmaximize();
    else scratchpadWindow.maximize();
  });
  handle(IPC.systemGetPermissions, async () => {
    const platform = runtimePlatformFor(process.platform);
    const microphone = systemPreferences.getMediaAccessStatus("microphone");
    const accessibilityGranted = await insertion.accessibilityReady();
    const automaticPasteReady = await insertion.automaticPasteReady();
    return permissionSnapshotForPlatform(
      platform,
      microphone,
      accessibilityGranted,
      hotkeys?.isGlobalHoldReady() ?? false,
      automaticPasteReady,
      hotkeys?.isToggleReady() ?? false,
    );
  });
  handle(IPC.systemGetLaunchAtLoginStatus, () => launchAtLoginStatusFor(app.getLoginItemSettings()));
  handle(IPC.systemOpenPermission, async (_event, kind: unknown) => {
    const permission = z.enum(["microphone", "accessibility"]).parse(kind);
    const platform = runtimePlatformFor(process.platform);
    if (permission === "accessibility") {
      // Prompting here registers the exact currently running signed build with
      // TCC. Merely opening the list can leave users toggling a stale entry
      // from a previous development build.
      await insertion.requestAccessibility();
      systemPreferences.isTrustedAccessibilityClient(true);
    }
    const url = permissionSettingsUrl(platform, permission);
    await shell.openExternal(url);
  });
  handle(IPC.systemAppInfo, () => ({
    version: app.getVersion(),
    platform: runtimePlatformFor(process.platform),
  }));
  handle(IPC.systemDiagnostics, () => collectDiagnostics());
  handle(IPC.systemDiagnosticsLog, () => diagnostics.read());
  handle(IPC.systemClearDiagnostics, () => diagnostics.clear());
  handle(IPC.systemModelCatalog, () => collectModelCatalog());
  handle(IPC.systemAddModelFamily, async (_event, rawRequest: unknown) => {
    const request = modelFamilyLibraryRequestSchema.parse(rawRequest);
    return runExclusiveModelOperation(async () => {
      // Serialize library membership with Apply so its catalog snapshot and
      // final routing commit cannot erase or omit a concurrently-added family.
      // The schema is an allowlist, and the packaged runtime catalog must also
      // provide the family for this platform before it can be persisted.
      if (!platformModelCatalog().families[request.familyId]) {
        throw new Error("This LocalScribe build does not package that model family for this platform.");
      }
      const previous = database.getSettings();
      if (previous.modelLibraryFamilyIds.includes(request.familyId)) return collectModelCatalog();
      const settings = database.saveSettings(appSettingsSchema.parse({
        ...previous,
        modelLibraryFamilyIds: [...previous.modelLibraryFamilyIds, request.familyId],
      }));
      notifySettingsChanged(settings);
      return collectModelCatalog();
    });
  });
  handle(IPC.systemApplyModelSelection, (_event, rawRequest: unknown) => {
    const request = modelSelectionApplyRequestSchema.parse(rawRequest);
    return applyModelSelection(request);
  });
  handle(IPC.systemInstallModel, async (_event, rawRequest: unknown) => {
    const request = modelInstallRequestSchema.parse(rawRequest);
    return runExclusiveModelOperation(async () => {
      assertModelSwitchAllowed();
      assertFamilyInLibrary(request.familyId);
      const catalog = modelCatalog(request.familyId);
      const tier = runtimeModelTier(catalog, request.tier);
      const modelRoot = modelRootForUserData(app.getPath("userData"));
      const warmSelection = worker.loadedSelection();
      const currentSettings = database.getSettings();
      const artifactBytes = Object.values(tier.manifest.files)
        .reduce((sum, file) => sum + file.bytes, 0);
      const replacesLoadedArtifact = request.replaceExisting
        && warmSelection !== null
        && modelResolution !== null
        && modelResolution.tier.familyId === request.familyId
        && modelResolution.tier.artifactId === tier.artifactId
        && workerModelSelectionsMatch(
          warmSelection,
          workerSelection(modelResolution.tier, currentSettings.asrMode),
        );
      // Installation is a disk/network data operation, not model activation.
      // It remains available when accelerator telemetry is missing or the
      // requested tier cannot currently fit in memory. The worker stages and
      // verifies repairs before promotion; do not delete the current artifact.
      const progressBase = {
        familyId: request.familyId,
        tier: tier.tier,
        artifactId: tier.artifactId,
      } as const;
      try {
        await installVerifiedModelArtifact({
          modelRoot,
          model: tier.manifest,
          replaceExisting: request.replaceExisting,
          install: () => worker.installModel(
            workerSelection(
              tier,
              request.familyId === currentSettings.activeModelFamilyId
                ? currentSettings.asrMode
                : "after-stop",
            ),
            {
              replacesLoadedArtifact,
              // The request budget is derived from the artifact's own size; see
              // installTimeoutMs. A flat cap made the largest tiers uninstallable
              // on any link slower than about 21 Mbit/s.
              artifactBytes,
              onProgress: ({ phase, completedBytes, totalBytes }) => {
                // The manifest total is main-owned. A worker that claims another
                // total is violating the pinned-artifact protocol, not reporting
                // a legitimate alternative download size.
                if (totalBytes !== artifactBytes) {
                  throw new Error("ASR worker reported progress for an unexpected model artifact size");
                }
                // Do not leak the worker protocol's `{ type, id }` envelope to
                // the strict renderer contract. The current serialized install
                // operation is the only source allowed to attach its catalog
                // identity to measured byte counters.
                notifyModelInstallProgress({
                  ...progressBase,
                  phase,
                  completedBytes,
                  totalBytes,
                });
              },
            },
          ),
        });
        // `installVerifiedModelArtifact` performed an independent main-process
        // SHA-256 verification after the worker's atomic promotion, so this is
        // the first point at which completion may be reported to the user.
        notifyModelInstallProgress({
          ...progressBase,
          phase: "complete",
          completedBytes: artifactBytes,
          totalBytes: artifactBytes,
          message: "Model downloaded and cryptographically verified.",
        });
      } catch (error) {
        let restoreError: unknown = null;
        // A protocol failure or timeout may terminate the shared installer
        // process. If it also held an unrelated warm runtime, reconstruct that
        // exact prior selection before reporting the failed disk operation.
        if (
          warmSelection
          && !quitting
          && !workerModelSelectionsMatch(worker.loadedSelection(), warmSelection)
        ) {
          try {
            await worker.ensureReady(warmSelection);
          } catch (caught) {
            restoreError = caught;
          }
        }
        notifyModelInstallProgress({
          ...progressBase,
          phase: "failed",
          message: "The model download or verification did not finish. No new model was applied.",
        });
        diagnostics.record({
          stage: "model",
          event: "install",
          outcome: "failed",
          modelFamily: request.familyId,
          modelTier: request.tier,
          detail: normalizeDiagnosticCode(error),
        });
        if (restoreError) {
          throw new Error(
            "The model install failed, and the previously loaded model could not be restored. The next dictation will retry loading it.",
            { cause: error },
          );
        }
        throw error;
      }
      return collectDiagnostics();
    });
  });
  handle(IPC.systemRemoveModel, async (_event, rawRequest: unknown) => {
    const request = modelRemoveRequestSchema.parse(rawRequest);
    return runExclusiveModelOperation(async () => {
      assertModelSwitchAllowed();
      assertFamilyInLibrary(request.familyId);
      const tier = runtimeModelTier(modelCatalog(request.familyId), request.tier);
      const activeResolution = await currentModelResolution();
      if (
        activeResolution.tier.familyId === request.familyId
        && activeResolution.tier.artifactId === tier.artifactId
      ) {
        throw new Error(
          "This model artifact is currently selected. Apply another model or performance tier before removing it.",
        );
      }
      const modelRoot = modelRootForUserData(app.getPath("userData"));
      await quarantineAndRemoveModelArtifact(modelRoot, tier.manifest);
      // The active selection and its warm runtime are unrelated to this
      // artifact, so removal must remain a storage-only operation.
      return collectDiagnostics();
    });
  });
}

function runDictationMenuAction(): void {
  const policy = dictationMenuPolicy(session.state, modelOperationInProgress());
  if (policy.action === "stop") finishListening();
  else if (policy.action === "start") beginListening("toggle");
}

function buildTrayMenu(): Menu {
  const policy = dictationMenuPolicy(session.state, modelOperationInProgress());
  return Menu.buildFromTemplate([
    {
      label: policy.label,
      enabled: policy.enabled,
      click: runDictationMenuAction,
    },
    { label: "Open LocalScribe", click: () => showHub("dictation") },
    { label: "Open Scratchpad", click: () => showScratchpad() },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
}

function installTrayMenu(): void {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu());
}

function refreshNativeMenus(): void {
  if (!databaseInitialized || quitting) return;
  try {
    installApplicationMenu();
  } catch (error) {
    console.warn("LocalScribe could not refresh its application menu", error);
  }
  try {
    installTrayMenu();
  } catch (error) {
    console.warn("LocalScribe could not refresh its tray menu", error);
  }
}

function createTray(): Tray {
  const icon = nativeImage.createEmpty();
  const result = new Tray(icon);
  result.setTitle("L");
  result.setToolTip("LocalScribe — local dictation");
  result.setContextMenu(buildTrayMenu());
  result.on("click", () => showHub("dictation"));
  result.on("right-click", () => result.setContextMenu(buildTrayMenu()));
  return result;
}

function installApplicationMenu(): void {
  /*
   * Read lazily, inside the click handler. Building the menu must not decrypt
   * anything: this runs on every session transition, six times per dictation,
   * on the thread that is inserting text into the user's app.
   */
  const latest = () => database.listTranscriptions(1)[0];
  const toggleShortcut = database.getSettings().toggleShortcut;
  const dictationItem = dictationMenuPolicy(session.state, modelOperationInProgress());
  const template: MenuItemConstructorOptions[] = [
    {
      label: "LocalScribe",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Settings…", accelerator: "CommandOrControl+,", click: () => showHub("settings") },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Dictation",
      submenu: [
        {
          label: dictationItem.label,
          enabled: dictationItem.enabled,
          accelerator: toggleShortcut,
          registerAccelerator: false,
          click: runDictationMenuAction,
        },
        {
          label: "Copy Last Transcript",
          accelerator: "CommandOrControl+Shift+C",
          enabled: database.hasTranscriptions(),
          click: () => {
            const transcript = latest();
            if (transcript) clipboard.writeText(transcript.text);
          },
        },
        { type: "separator" },
        { label: "Open Dictation History", click: () => showHub("dictation") },
      ],
    },
    {
      label: "My Voice",
      submenu: [
        { label: `${database.countDictionary()} dictionary entries`, enabled: false },
        { label: `${database.countSnippets()} snippets`, enabled: false },
        { type: "separator" },
        { label: "Open Dictionary", click: () => showHub("dictionary") },
        { label: "Open Snippets", click: () => showHub("snippets") },
        { label: "Open Scratchpad", click: () => showScratchpad() },
      ],
    },
    { role: "editMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/*
 * The packaged smoke gate needs a deterministic startup verdict from an
 * unattended run. Without one it could only infer success from the process
 * still being alive — and a startup failure showed a modal NSAlert first,
 * which blocks the main thread until someone dismisses it. With nobody at the
 * machine the process stayed alive, so the gate passed builds that could never
 * start. Under this flag the app reports readiness on stdout and fails without
 * a dialog; unflagged runs are unchanged, keeping the visible failure notice a
 * real user needs.
 */
const smokeMode = process.env.LOCALSCRIBE_SMOKE === "1";
const SMOKE_READY_MARKER = "localscribe-startup-ready";

startupPromise = app.whenReady().then(async () => {
  if (!hasSingleInstanceLock || quitting) return;
  app.setName("LocalScribe");
  /*
   * Stand the failure trail up before the first startup gate. The packaged
   * app's stdout and stderr are /dev/null, so integrity, platform, or helper
   * failures must also leave a privacy-safe durable verdict.
   */
  diagnostics = new DiagnosticsRecorder(path.join(app.getPath("userData"), "diagnostics"), {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron ?? "unknown",
  });
  runtimePlatformFor(process.platform);
  runtimeArchitectureFor(process.arch);
  verifyPackagedResourceIntegrity({ isPackaged: app.isPackaged });
  const nativeHelperPinned = insertion.pinNativeHelperIntegrity();
  if (
    app.isPackaged
    && !nativeHelperPinned
  ) {
    throw new Error("The packaged native input helper could not be integrity-pinned.");
  }
  installRendererProtocol();
  installPermissionHandlers();
  runtimeModelPlatformCatalog = loadRuntimePlatformModelCatalog(runtimeModelManifestDirectory());
  database = new LocalDatabase(
    path.join(app.getPath("userData"), "localscribe.db"),
    defaultSettingsForRuntimeCatalog(platformModelCatalog()),
  );
  databaseInitialized = true;
  database.purgeExpiredTranscriptions(database.getSettings().historyRetentionDays);
  const temporaryDirectory = app.getPath("temp");
  await cleanStaleAudioCaches(temporaryDirectory);
  if (quitting) return;
  audioCacheRoot = await createAudioCache(temporaryDirectory);
  if (quitting) return;
  const workerDirectory = app.isPackaged
    ? path.join(process.resourcesPath, "worker")
    : path.join(app.getAppPath(), "worker");
  /*
   * Persistent, app-owned, and deliberately outside the packaged resource tree
   * the startup integrity check covers. Importing the ML stack is 1,492 modules
   * and cost 2.11-2.86s on every model load while bytecode was disabled; a warm
   * cache brings that to 0.70-0.87s. It is a cache in the ordinary sense —
   * deleting it costs one slow load and nothing else — and CPython invalidates
   * entries itself when a source file's timestamp or size changes, which is
   * what makes an app update pick up new code rather than stale bytecode.
   */
  const bytecodeCacheDirectory = path.join(app.getPath("userData"), "python-bytecode-cache");
  await mkdir(bytecodeCacheDirectory, { recursive: true });
  if (quitting) return;
  worker = new WorkerSupervisor(
    workerDirectory,
    path.join(app.getPath("userData"), "models"),
    app.isPackaged
      ? path.join(app.getPath("userData"), "python-env")
      : path.join(app.getAppPath(), ".worker-venv"),
    app.isPackaged
      ? path.join(process.resourcesPath, "python-runtime")
      : null,
    "localscribe_worker",
    audioCacheRoot,
    bytecodeCacheDirectory,
  );
  workerInitialized = true;
  /*
   * The last line of defence for the "never evict a working model for an
   * unproven one" invariant. `ensureReadyUnlocked` calls this before it stops
   * the running process, so every switch — Auto drift at a recording boundary,
   * an Apply, a post-install reload — has to satisfy it, not only the paths
   * that remembered to check first.
   *
   * The fast path is stat-only. It falls back to a full digest pass only when
   * the artifact has not been verified in this process yet, which is the case
   * where reading it is exactly what is required.
   */
  worker.setTargetLoadableGuard(async (selection) => {
    const modelRoot = modelRootForUserData(app.getPath("userData"));
    const manifest = manifestForWorkerSelection(platformModelCatalog(), selection);
    if (!manifest) {
      diagnostics.record({
        stage: "model",
        event: "switch_refused",
        outcome: "failed",
        modelTier: selection.tier,
        detail: "model_selection_mismatch",
      });
      throw new Error(
        "The selected local speech model does not match a supported model, quality, compute, and dictation-mode profile, so LocalScribe kept the model that is currently working.",
      );
    }
    if (await modelArtifactIsVerifiedNow(modelRoot, manifest)) return;
    const verification = await verifyModelDirectory(modelRoot, manifest);
    if (verification.verified) return;
    diagnostics.record({
      stage: "model",
      event: "switch_refused",
      outcome: "failed",
      modelTier: selection.tier,
      detail: verification.verificationStatus === "missing"
        ? "model_not_installed"
        : "model_verification_failed",
    });
    throw new Error(
      verification.verificationStatus === "missing"
        ? "Local speech model is not installed. Open LocalScribe Settings > Model & Performance to install it before dictating."
        : "The selected local speech model failed verification, so LocalScribe kept the model that is currently working. Reinstall it from Settings > Model & Performance.",
    );
  });
  // Startup is an unloaded boundary. Capture one unbiased hardware snapshot;
  // later diagnostics remain observational and dictation keeps models warm.
  await refreshModelResolution({ reprobeUnloaded: true });
  // A quit request can interrupt the initial hardware probe. The shutdown
  // path waits for this promise before closing the database; do not construct
  // app windows, IPC handlers, or hotkeys after that request.
  if (quitting) return;
  registerIpc();
  pillWindow = createPillWindow();
  startPillDisplayFollowing();
  if (shouldOpenSettingsAtStartup(app.getLoginItemSettings().wasOpenedAtLogin)) {
    settingsWindow = createSettingsWindow();
  }
  tray = createTray();
  installApplicationMenu();
  const shortcutSettings = database.getSettings();
  hotkeys = new HotkeyService(
    () => beginListening("hold"),
    () => {
      if (session.state === "listening" && session.activation === "hold") finishListening();
    },
    () => (session.state === "listening" ? finishListening() : beginListening("toggle")),
    new MacControlMonitor(defaultMacControlMonitorPath({
      allowEnvironmentOverride: !app.isPackaged,
      workingDirectory: app.getAppPath(),
    })),
    shortcutSettings.holdShortcut,
    shortcutSettings.toggleShortcut,
  );
  if (systemPreferences.isTrustedAccessibilityClient(false)) {
    try {
      hotkeys.start();
      diagnostics.record({ stage: "hotkey", event: "global_register", outcome: "ok" });
    } catch (error) {
      /*
       * This is the failure that made "my shortcut does nothing" impossible to
       * diagnose: the warning went to a stdout that is /dev/null in the
       * packaged app, and the fallback registration looks identical to success
       * from the outside. Record which path actually took effect.
       */
      console.warn("Global hold-to-talk could not start", error);
      diagnostics.record({
        stage: "hotkey",
        event: "global_register",
        outcome: "failed",
        detail: normalizeDiagnosticCode(error),
      });
      hotkeys.startFallback();
      diagnostics.record({ stage: "hotkey", event: "fallback_register", outcome: "ok" });
    }
  } else {
    hotkeys.startFallback();
    diagnostics.record({
      stage: "hotkey",
      event: "fallback_register",
      outcome: "ok",
      permission: "accessibility_denied",
    });
  }
  /*
   * The toggle is recorded separately, and only after both branches above have
   * run, because neither of them reports it.
   *
   * `hotkeys.start()` does not throw when the accelerator cannot be claimed —
   * push-to-talk has to keep working when another app owns the toggle — so the
   * `global_register: ok` above was written for runs in which nothing was
   * registered at all. That "ok" then went into the durable diagnostics file,
   * which is the artifact the user copies to answer "why does my shortcut do
   * nothing". It answered wrongly.
   */
  diagnostics.record({
    stage: "hotkey",
    event: "toggle_register",
    outcome: hotkeys.isToggleReady() ? "ok" : "failed",
    detail: hotkeys.toggleRegistrationDiagnosticDetail() ?? undefined,
  });
  startAccessibilityUpgradeCheck();

  app.on("activate", () => {
    showHub("dictation");
  });
  // This is a readiness verdict, not a startup-attempt marker. It is emitted
  // only after windows, IPC, menus, worker policy, and hotkeys are established.
  diagnostics.record({ stage: "lifecycle", event: "startup", outcome: "ok" });
});
void startupPromise.then(() => {
  if (smokeMode && !quitting) process.stdout.write(`${SMOKE_READY_MARKER}\n`);
}).catch(async (error: unknown) => {
  if (quitting) return;
  diagnostics.record({
    stage: "lifecycle",
    event: "startup",
    outcome: "failed",
    detail: normalizeDiagnosticCode(error),
  });
  quitting = true;
  console.error("LocalScribe startup failed", error);
  if (!smokeMode) {
    dialog.showErrorBox(
      "LocalScribe could not start",
      "The local application could not initialize. Quit LocalScribe and try opening it again.",
    );
  }
  await releaseRuntimeResources();
  app.exit(1);
});

app.on("second-instance", () => {
  void startupPromise?.then(() => {
    if (!quitting) showHub("dictation");
  }).catch(() => {
    // The startup error path already owns user-visible failure reporting.
  });
});

app.on("window-all-closed", () => {
  // The pill and global dictation service keep the app resident.
});

function releaseRuntimeResources(): Promise<void> {
  runtimeReleasePromise ??= (async () => {
    let releaseFailed = false;
    const workerShutdown = workerInitialized
      ? worker.shutdown().catch((error: unknown) => {
          releaseFailed = true;
          console.warn("LocalScribe worker could not shut down cleanly", error);
        })
      : Promise.resolve();
    workerInitialized = false;

    // Close synchronous local state immediately while the worker exits.
    if (databaseInitialized) {
      try {
        database.close();
      } catch (error) {
        releaseFailed = true;
        console.warn("LocalScribe database could not close cleanly", error);
      }
      databaseInitialized = false;
    }
    try {
      tray?.destroy();
    } catch (error) {
      releaseFailed = true;
      console.warn("LocalScribe tray could not close cleanly", error);
    }
    tray = null;

    await workerShutdown;
    try {
      await removeAudioCache(app.getPath("temp"), audioCacheRoot);
      audioCacheRoot = null;
    } catch (error) {
      releaseFailed = true;
      console.warn("LocalScribe temporary audio could not be removed cleanly", error);
    }
    diagnostics.record({
      stage: "lifecycle",
      event: "shutdown",
      outcome: releaseFailed ? "failed" : "ok",
    });
    // The app exits immediately after this promise. Without an explicit drain,
    // the final startup/shutdown failure can remain only in an abandoned
    // Promise and never reach the durable diagnostics file.
    await diagnostics.flush();
  })();
  return runtimeReleasePromise;
}

async function finishShutdown(): Promise<void> {
  try {
    await startupPromise;
  } catch (error) {
    console.warn("LocalScribe startup was interrupted by shutdown", error);
  }
  await releaseRuntimeResources();
  app.exit(0);
}

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  beginShutdown();
  void finishShutdown();
});

function beginShutdown(): boolean {
  if (quitting) return false;
  quitting = true;
  if (pillDisplayTimer) clearInterval(pillDisplayTimer);
  if (accessibilityTimer) clearInterval(accessibilityTimer);
  finalizeWatchdog.cancel();
  noticeTimer.cancel();
  pillDisplayTimer = null;
  accessibilityTimer = null;
  // Prevent a forced hotkey reset from turning a held key into a new
  // finalization request while the app is already shutting down.
  insertion.cancelSession();
  activeSessionId = null;
  activeDictationTier = undefined;
  session = { state: "idle" };
  try {
    hotkeys?.stop();
  } catch (error) {
    console.warn("LocalScribe hotkeys could not stop cleanly", error);
  }
  /*
   * Quit closes the database while the worker shutdown and temporary-audio
   * removal are still running — seconds, for a large model. The macOS menu bar
   * stayed installed and live for all of it, and "Copy Last Transcript" and the
   * My Voice items read the database, so a click in that window threw inside
   * main. Retire the menu with the same latch that retires everything else.
   */
  Menu.setApplicationMenu(null);
  try {
    if (workerInitialized) {
      // Latch first: abort only kills the live process, and a model operation
      // already queued would otherwise start a replacement.
      worker.retire();
      worker.abort("LocalScribe is quitting");
    }
  } catch (error) {
    console.warn("LocalScribe worker could not be aborted cleanly", error);
  }
  return true;
}
