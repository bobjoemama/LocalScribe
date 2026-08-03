import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { rm, writeFile } from "node:fs/promises";
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
  shell,
  systemPreferences,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from "electron";
import { z } from "zod";
import {
  appSettingsSchema,
  appSettingsPatchSchema,
  appProfileSchema,
  dictionaryEntrySchema,
  IPC,
  MAX_HISTORY_ITEMS,
  modelFamilyLibraryRequestSchema,
  modelInstallRequestSchema,
  modelRemoveRequestSchema,
  modelSelectionApplyRequestSchema,
  navigationTargetSchema,
  pillModeSchema,
  sessionSnapshotSchema,
  snippetSchema,
  transcribeAudioSchema,
  type Diagnostics,
  type ModelCatalog,
  type ModelFamilyId,
  type ModelPerformanceTier,
  type ModelSelectionApplyResult,
  type NavigationTarget,
  type PillMode,
  type SessionSnapshot,
} from "./shared/contracts";
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
  type WorkerComputeType,
  type WorkerModelSelection,
} from "./main/worker/workerSupervisor";
import { HotkeyService } from "./main/hotkeys/hotkeyService";
import { defaultMacControlMonitorPath, MacControlMonitor } from "./main/hotkeys/macControlMonitor";
import { reconcileAccessibilityHotkeys } from "./main/hotkeys/accessibilityReconciler";
import { InsertionService } from "./main/insertion/insertionService";
import { buildDictionaryAsrContext } from "./shared/dictionaryContext";
import { applyLocalTextRules } from "./shared/textPipeline";
import { transformDictation } from "./shared/text";
import { ERROR_NOTICE_DURATION_MS, normalizeDictationErrorMessage } from "./shared/dictationErrors";
import {
  loadRuntimePlatformModelCatalog,
  resolveModelPerformance,
  verifyRuntimeModelCatalog,
  type ModelPerformanceResolution,
  type RuntimeModelCatalog,
  type RuntimePlatformModelCatalog,
  type RuntimeModelTierSpec,
} from "./main/modelSpec";
import {
  buildModelCatalogSnapshot,
  modelRootForUserData,
} from "./main/modelCatalogSnapshot";
import {
  assertSafeModelRoot,
  installVerifiedModelArtifact,
  modelArtifactDirectory,
} from "./main/modelOperations";
import { verifyPackagedResourceIntegrity } from "./main/resourceIntegrity";
import {
  permissionSettingsUrl,
  permissionSnapshotForPlatform,
  runtimePlatformFor,
} from "./main/platformCapabilities";
import { SETTINGS_WINDOW_LAYOUT } from "./shared/windowLayout.mts";
import {
  PILL_HOVER_HIT_PADDING,
  PILL_LAYOUT,
  PILL_WINDOW_BOTTOM_MARGIN,
  pillSizeFor,
} from "./shared/pillLayout";
import {
  RENDERER_PROTOCOL_SCHEME,
  rendererUrlForRuntime,
  resolvePackagedRendererPath,
  type RendererSurface,
} from "./main/rendererProtocol";
import {
  cleanStaleAudioCaches,
  createAudioCache,
  removeAudioCache,
} from "./main/audioCache";
import { assertRendererSurfaceCanInvoke } from "./main/ipcAuthorization";
import {
  launchAtLoginStatusFor,
  loginItemQueryOptions,
  loginItemSettings,
  shouldOpenSettingsAtStartup,
  WINDOWS_APP_USER_MODEL_ID,
} from "./main/windowsLifecycle";

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
let errorDismissTimer: NodeJS.Timeout | null = null;
let audioCacheRoot: string | null = null;
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
let runtimeModelPlatformCatalog: RuntimePlatformModelCatalog | null = null;
let modelResolution: ModelPerformanceResolution | null = null;
let previousAutoTier: ModelPerformanceTier | undefined;
let activeDictationTier: ModelPerformanceTier | undefined;
let activeSessionId: string | null = null;
let activeSessionModelResolution: {
  sessionId: string;
  promise: Promise<ModelPerformanceResolution>;
} | null = null;
let acceleratorSnapshot: WorkerAcceleratorSnapshot | null = null;
let modelOperationTail: Promise<void> = Promise.resolve();
let modelOperationCount = 0;
// Squirrel must process install/update/uninstall lifecycle events before the
// app acquires its normal instance lock or creates any windows/tray state.
// Vite emits the Electron main process as CommonJS, where `import.meta.url`
// is not available. Anchor createRequire to Electron's guaranteed-absolute
// application path so the same bootstrap works in development and app.asar.
if (process.platform === "win32") app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
if (process.platform === "win32" && process.argv.includes("--squirrel-uninstall")) {
  try {
    app.setLoginItemSettings(loginItemSettings(false, process.platform, process.execPath));
  } catch (error) {
    console.warn("LocalScribe could not remove its login startup entry during uninstall", error);
  }
}
const appRequire = createRequire(path.join(app.getAppPath(), "package.json"));
const squirrelStartup = Boolean(appRequire("electron-squirrel-startup"));
const hasSingleInstanceLock = !squirrelStartup && app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

const uuidSchema = z.string().uuid();
const limitSchema = z.number().int().min(1).max(MAX_HISTORY_ITEMS).optional();
const dictionaryInputSchema = dictionaryEntrySchema.pick({ phrase: true, replacement: true });
const snippetInputSchema = snippetSchema.pick({ trigger: true, expansion: true });
const profileInputSchema = appProfileSchema.omit({ id: true, createdAt: true });
const scratchpadSchema = z.string().max(1_000_000);

function platformModelCatalog(): RuntimePlatformModelCatalog {
  if (!runtimeModelPlatformCatalog) throw new Error("The packaged model catalog was not loaded");
  return runtimeModelPlatformCatalog;
}

function modelCatalog(
  familyId: ModelFamilyId = database.getSettings().activeModelFamilyId,
): RuntimeModelCatalog {
  return platformModelCatalog().families[familyId];
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
  const result = modelOperationTail.catch(() => undefined).then(operation);
  modelOperationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result.finally(() => {
    modelOperationCount -= 1;
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
  if (process.platform === "darwin") {
    return {
      kind: "apple-unified",
      displayName: "Apple Silicon GPU · MLX",
      totalMemoryBytes: null,
      freeMemoryBytes: null,
      memoryBasis: "unavailable",
    };
  }
  if (process.platform === "win32") {
    return {
      kind: "nvidia-cuda",
      displayName: "NVIDIA GPU · CUDA",
      totalMemoryBytes: null,
      freeMemoryBytes: null,
      memoryBasis: "unavailable",
    };
  }
  return {
    kind: "unsupported",
    displayName: "Unsupported accelerator",
    totalMemoryBytes: null,
    freeMemoryBytes: null,
    memoryBasis: "unavailable",
  };
}

function acceleratorDiagnostics(): Diagnostics["accelerator"] {
  if (!acceleratorSnapshot) return unavailableAccelerator();
  return {
    kind: acceleratorSnapshot.kind,
    displayName: acceleratorSnapshot.kind === "apple-unified"
      ? `${acceleratorSnapshot.displayName} · MLX`
      : `${acceleratorSnapshot.displayName} · CUDA`,
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
    && workerModelSelectionsMatch(warmSelection, workerSelection(cached.tier));
  try {
    const liveSnapshot = await worker.deviceInfo();
    acceleratorSnapshot = liveSnapshot;
    if (!cachedMatchesWarmSelection) {
      throw new Error("The warm local speech model does not match the active Auto selection.");
    }
    const next = await refreshModelResolution({
      memory: memorySnapshotWithoutWarmModel(liveSnapshot, cached),
    });
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

function workerSelection(tier: RuntimeModelTierSpec): WorkerModelSelection {
  return {
    modelId: tier.manifest.modelId,
    tier: tier.tier,
    computeType: workerComputeType(tier),
  };
}

function workerComputeType(tier: RuntimeModelTierSpec): WorkerComputeType {
  switch (tier.precision) {
    case "fp16":
      return "float16";
    case "8-bit":
      return "int8";
    case "4-bit":
      return "int4";
    case "bf16":
      return "bfloat16";
    case "q8_0":
    case "q4_k":
      return tier.precision;
    case "float16":
    case "int8_float16":
    case "int8":
      return tier.precision;
  }
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
  switch (resolution.reason) {
    case "explicit":
      return `${resolution.effectiveTier} was selected explicitly.`;
    case "dictation-active":
      return `${resolution.effectiveTier} is pinned until the active dictation finishes.`;
    case "auto-highest-fit":
      return `Auto selected ${resolution.effectiveTier}, the highest tier that fits the current memory budget.`;
    case "auto-hysteresis-hold":
      return `Auto kept ${resolution.effectiveTier} to avoid switching after a small memory change.`;
    case "auto-insufficient-memory":
      return "Auto could not verify enough free accelerator memory. Dictation stays blocked until a tier fits.";
  }
}

async function collectDiagnosticsForResolution(
  resolution: ModelPerformanceResolution,
): Promise<Diagnostics> {
  const modelRoot = path.join(app.getPath("userData"), "models");
  const catalog = modelCatalog(resolution.tier.familyId);
  const verifications = await verifyRuntimeModelCatalog(modelRoot, catalog);
  const model = resolution.tier.manifest;
  const verification = verifications[resolution.effectiveTier];
  return {
    platform: process.platform,
    architecture: process.arch,
    backend: model.backend,
    databaseIntegrity: database.integrityCheck(),
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
        workerSelection(resolution.tier),
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
      options: Object.values(catalog.tiers).map((tier) => {
        const tierVerification = verifications[tier.tier];
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

function hardenWindow(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
}

function hideWindowInsteadOfClosing(window: BrowserWindow): void {
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
}

function createSettingsWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: SETTINGS_WINDOW_LAYOUT.defaultWidth,
    height: SETTINGS_WINDOW_LAYOUT.defaultHeight,
    minWidth: SETTINGS_WINDOW_LAYOUT.minimumWidth,
    minHeight: SETTINGS_WINDOW_LAYOUT.minimumHeight,
    title: "LocalScribe",
    show: false,
    backgroundColor: "#f3f1ed",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 18, y: 18 } } : {}),
    webPreferences: commonWebPreferences(),
  });
  window.removeMenu();
  hideWindowInsteadOfClosing(window);
  hardenWindow(window);
  void window.loadURL(rendererUrl("settings"));
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    settingsWindow = null;
  });
  return window;
}

function createScratchpadWindow(): BrowserWindow {
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
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 18, y: 18 } } : {}),
    alwaysOnTop: true,
    type: process.platform === "darwin" ? "panel" : undefined,
    webPreferences: commonWebPreferences(),
  });
  window.removeMenu();
  hideWindowInsteadOfClosing(window);
  if (process.platform === "darwin") window.setWindowButtonVisibility(false);
  window.setAlwaysOnTop(true, process.platform === "darwin" ? "floating" : "normal");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hardenWindow(window);
  void window.loadURL(rendererUrl("scratchpad"));
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    scratchpadWindow = null;
  });
  return window;
}

function showScratchpad(): void {
  scratchpadWindow ??= createScratchpadWindow();
  if (scratchpadWindow.isMinimized()) scratchpadWindow.restore();
  scratchpadWindow.show();
  scratchpadWindow.focus();
}

function showHub(target: NavigationTarget = "dictation"): void {
  if (target === "scratchpad") {
    showScratchpad();
    return;
  }
  settingsWindow ??= createSettingsWindow();
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
  const { width, height } = pillSizeFor(session.state, pillMode, session.activation);
  const [currentWidth, currentHeight] = pillWindow.getSize();
  if (currentWidth !== width || currentHeight !== height) pillWindow.setSize(width, height, false);
  positionPill(pillWindow);
}

function pointInside(bounds: Electron.Rectangle, point: Electron.Point, padding: number): boolean {
  return point.x >= bounds.x - padding
    && point.x < bounds.x + bounds.width + padding
    && point.y >= bounds.y - padding
    && point.y < bounds.y + bounds.height + padding;
}

function bootstrapPillHover(): void {
  if (!pillWindow || pillWindow.isDestroyed() || !pillWindow.isVisible()) return;
  if (session.state !== "idle" || pillMode !== "collapsed") return;
  if (!pointInside(pillWindow.getBounds(), screen.getCursorScreenPoint(), PILL_HOVER_HIT_PADDING)) return;
  // Only enlarge the transparent native surface here. The renderer still owns
  // when expanded controls become visible and hides them before contracting.
  pillMode = "hover";
  resizePill();
}

function startPillDisplayFollowing(): void {
  if (pillDisplayTimer) return;
  pillDisplayTimer = setInterval(() => {
    if (pillWindow && !pillWindow.isDestroyed() && pillWindow.isVisible()) {
      positionPill(pillWindow);
      bootstrapPillHover();
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
    type: process.platform === "darwin" ? "panel" : undefined,
    webPreferences: commonWebPreferences(),
  });
  window.setHasShadow(false);
  window.setAlwaysOnTop(true, process.platform === "darwin" ? "floating" : "pop-up-menu");
  hardenWindow(window);
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (process.platform === "darwin") window.setHiddenInMissionControl(true);
  if (process.platform === "win32") {
    // Electron does not emit app.before-quit for Windows logout, restart, or
    // shutdown. BrowserWindow session-end is the only in-process cleanup
    // opportunity before the OS tears the process down.
    window.once("session-end", () => {
      if (!beginShutdown()) return;
      void releaseRuntimeResources();
    });
  }
  void window.loadURL(rendererUrl("pill"));
  window.once("ready-to-show", () => {
    syncPillVisibility();
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
  if (errorDismissTimer) {
    clearTimeout(errorDismissTimer);
    errorDismissTimer = null;
  }
  const normalized = next.state === "error"
    ? { ...next, message: normalizeDictationErrorMessage(next.message) }
    : next;
  session = sessionSnapshotSchema.parse(normalized);
  if (session.state === "idle" || session.state === "success" || session.state === "error") {
    activeDictationTier = undefined;
    activeSessionId = null;
    activeSessionModelResolution = null;
  }
  if (session.state !== "idle") pillMode = "collapsed";
  resizePill();
  if (process.platform === "darwin" && database) installApplicationMenu();
  for (const window of [pillWindow, settingsWindow, scratchpadWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send(IPC.sessionChanged, session);
  }
  syncPillVisibility();
  if (session.state === "error") {
    const message = session.message;
    errorDismissTimer = setTimeout(() => {
      errorDismissTimer = null;
      if (session.state !== "error" || session.message !== message) return;
      insertion.cancelSession();
      setSession({ state: "idle" });
    }, ERROR_NOTICE_DURATION_MS);
    errorDismissTimer.unref();
  }
  return session;
}

function failSession(error: unknown): SessionSnapshot {
  insertion.cancelSession();
  return setSession({ state: "error", message: normalizeDictationErrorMessage(error) });
}

function notifyHistoryChanged(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(IPC.historyChanged);
  }
}

/** Broadcast only validated, persisted settings after a successful save. */
function notifySettingsChanged(settings: ReturnType<LocalDatabase["getSettings"]>): void {
  for (const window of [pillWindow, settingsWindow, scratchpadWindow]) {
    if (!window || window.isDestroyed()) continue;
    try {
      window.webContents.send(IPC.settingsChanged, settings);
    } catch (error) {
      console.warn("LocalScribe could not deliver a persisted settings update to one window", error);
    }
  }
}

function beginListening(activation: "hold" | "toggle" = "toggle"): SessionSnapshot {
  if (session.state !== "idle" && session.state !== "success" && session.state !== "error") return session;
  if (modelOperationInProgress()) {
    return failSession("Wait for the local model operation to finish before dictating.");
  }
  const preference = database.getSettings().modelPerformanceMode;
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
    const targetCatalog = platformModelCatalog().families[request.familyId];
    if (!targetCatalog) {
      throw new Error("This LocalScribe build does not package that model family for this platform.");
    }
    assertFamilyInLibrary(request.familyId);

    const previousSettings = database.getSettings();
    const samePersistedSelection = (
      previousSettings.activeModelFamilyId === request.familyId
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
        workerSelection(currentResolutionForSelection.tier),
      )
    ) {
      // Apply is a no-op only when the exact resolved runtime is already warm.
      const [catalog, diagnostics] = await Promise.all([
        collectModelCatalogForSettings(previousSettings),
        collectDiagnosticsForResolution(currentResolutionForSelection),
      ]);
      return { settings: previousSettings, catalog, diagnostics };
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
      modelPerformanceMode: request.performanceMode,
    });
    let targetResolution: ModelPerformanceResolution;

    try {
      // A fresh worker is the load/unload boundary. Probe only after the old
      // runtime is gone so its allocation cannot make Auto select downward.
      await worker.shutdown();
      await probeUnloadedAccelerator();
      previousAutoTier = undefined;
      targetResolution = resolveSelection(request.familyId, request.performanceMode);
      assertResolutionFitsMemory(targetResolution);

      const modelRoot = modelRootForUserData(app.getPath("userData"));
      const verifications = await verifyRuntimeModelCatalog(modelRoot, targetCatalog);
      const targetVerification = verifications[targetResolution.effectiveTier];
      if (!targetVerification.verified || targetVerification.verificationStatus !== "verified") {
        const action = targetVerification.present ? "repair" : "install";
        throw new Error(
          `The selected local speech model is not cryptographically verified. ${action === "repair" ? "Repair" : "Install"} this exact model and quality tier before applying it.`,
        );
      }

      // Eager loading proves the exact engine, model, quantization, and current
      // memory state before either routing field becomes durable.
      await worker.ensureReady(workerSelection(targetResolution.tier));

      const [catalog, diagnostics] = await Promise.all([
        collectModelCatalogForSettings(candidateSettings),
        collectDiagnosticsForResolution(targetResolution),
      ]);
      // Loading and catalog verification can take minutes. Merge the two model
      // routing fields into the latest row immediately before the synchronous
      // write so a microphone, shortcut, launch-at-login, or other settings
      // update committed while Apply was running cannot be reverted here.
      // There must be no await between this read and write.
      const latestSettings = database.getSettings();
      const settings = database.saveSettings(appSettingsSchema.parse({
        ...latestSettings,
        activeModelFamilyId: request.familyId,
        modelPerformanceMode: request.performanceMode,
      }));
      modelResolution = targetResolution;
      if (request.performanceMode === "auto" && targetResolution.fitsMemoryBudget) {
        previousAutoTier = targetResolution.effectiveTier;
      }
      notifySettingsChanged(settings);
      return { settings, catalog, diagnostics };
    } catch (error) {
      // Target load and durable settings are one transaction from the user's
      // perspective. A failed target is always terminated, and the previous
      // warm selection is restored best-effort without altering its settings.
      let restoreError: unknown = null;
      let restoreSkippedForShutdown = false;
      try {
        await worker.shutdown();
        if (previousWarmSelection) {
          if (quitting) restoreSkippedForShutdown = true;
          else await worker.ensureReady(previousWarmSelection);
        }
      } catch (rollbackError) {
        restoreError = rollbackError;
      }
      acceleratorSnapshot = previousAcceleratorSnapshot;
      previousAutoTier = previousAutoTierSnapshot;
      modelResolution = previousResolution;
      const reason = error instanceof Error ? error.message : "The target model could not be loaded.";
      const restoreDetail = restoreError
        ? " The previous model settings were kept, but its warm runtime could not be restored; the next dictation will retry loading it."
        : restoreSkippedForShutdown
          ? " The previous model settings were kept; its runtime was not restarted because LocalScribe is shutting down."
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
  handle(IPC.sessionCancel, () => {
    insertion.cancelSession();
    activeSessionId = null;
    if (
      session.state === "finalizing"
      || session.state === "transcribing"
      || session.state === "inserting"
    ) {
      worker.abort("Dictation was cancelled");
    }
    return setSession({ state: "idle" });
  });
  handle(IPC.sessionFail, (_event, message: unknown) => failSession(message));

  handle(IPC.sessionTranscribe, async (_event, rawInput: unknown) => {
    const input = transcribeAudioSchema.parse(rawInput);
    if (session.state !== "finalizing" || session.sessionId !== input.sessionId) {
      throw new Error("Rejected audio from an inactive dictation session");
    }
    assertActiveSession(input.sessionId);
    const settings = database.getSettings();
    const cacheRoot = audioCacheRoot;
    if (!cacheRoot) throw new Error("Private audio storage is not ready.");
    const audioPath = path.join(cacheRoot, `${randomUUID()}.wav`);
    await writeFile(audioPath, new Uint8Array(input.wav), { mode: 0o600, flag: "wx" });
    setSession({
      state: "transcribing",
      sessionId: input.sessionId,
      message: "Transcribing locally",
    });
    try {
      const resolution = await currentModelResolution();
      assertResolutionFitsMemory(resolution);
      const concreteModel = resolution.tier.manifest;
      const dictionary = database.listDictionary();
      const terms = buildDictionaryAsrContext(dictionary);
      const result = await worker.transcribe({
        model: workerSelection(resolution.tier),
        audioPath,
        allowedRoot: cacheRoot,
        language: settings.language,
        context: terms,
      });
      assertActiveSession(input.sessionId);
      const targetAppId = await insertion.targetAppId();
      assertActiveSession(input.sessionId);
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
      if (settingsWindow?.isFocused() || scratchpadWindow?.isFocused()) {
        // Do not inject text into LocalScribe's own UI.
        const outcome = await insertion.copyAndPaste(text, false);
        assertActiveSession(input.sessionId);
        setSession({
          state: "success",
          sessionId: input.sessionId,
          message: outcome === "copied" ? "Copied to clipboard" : "Inserted",
        });
      } else {
        const automaticPasteReady = await insertion.automaticPasteReady();
        const canAutoPaste = settings.autoPaste && automaticPasteReady;
        setSession({
          state: "inserting",
          sessionId: input.sessionId,
          message: canAutoPaste ? "Inserting" : "Copying",
        });
        const outcome = await insertion.copyAndPaste(text, canAutoPaste);
        assertActiveSession(input.sessionId);
        const copiedMessage = settings.autoPaste && !automaticPasteReady && process.platform === "darwin"
          ? "Copied — allow Accessibility"
          : "Copied to clipboard";
        const successMessage = outcome === "pasted"
          ? "Inserted"
          : outcome === "pasted-with-copy"
            ? "Inserted · copied as backup"
            : copiedMessage;
        setSession({
          state: "success",
          sessionId: input.sessionId,
          message: successMessage,
        });
      }
      const record = settings.keepHistory
        ? database.saveTranscription({
            durationMs: input.durationMs,
            text,
            language: result.language,
            modelId: concreteModel.modelId,
            status: "complete",
            sourceAppId: targetAppId,
          })
        : {
            id: randomUUID(),
            createdAt: Date.now(),
            durationMs: input.durationMs,
            text,
            language: result.language,
            modelId: concreteModel.modelId,
            status: "complete" as const,
            sourceAppId: targetAppId,
          };
      const purged = database.purgeExpiredTranscriptions(settings.historyRetentionDays);
      if (settings.keepHistory || purged > 0) notifyHistoryChanged();
      const completedSessionId = input.sessionId;
      setTimeout(() => {
        if (session.state === "success" && session.sessionId === completedSessionId) {
          setSession({ state: "idle" });
        }
      }, 1_400);
      return record;
    } catch (error) {
      if (activeSessionId === input.sessionId) failSession(error);
      throw error;
    } finally {
      await rm(audioPath, { force: true });
    }
  });

  handle(IPC.historyList, (_event, limit?: unknown) => database.listTranscriptions(limitSchema.parse(limit)));
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
    await writeFile(result.filePath, `${JSON.stringify(database.exportTranscriptions(), null, 2)}\n`, {
      mode: 0o600,
      flag: "w",
    });
    return result.filePath;
  });

  handle(IPC.dictionaryList, () => database.listDictionary());
  handle(IPC.dictionarySave, (_event, input: unknown) =>
    database.saveDictionary(dictionaryInputSchema.parse(input)),
  );
  handle(IPC.dictionaryDelete, (_event, id: unknown) => database.deleteDictionary(uuidSchema.parse(id)));

  handle(IPC.snippetsList, () => database.listSnippets());
  handle(IPC.snippetsSave, (_event, input: unknown) => database.saveSnippet(snippetInputSchema.parse(input)));
  handle(IPC.snippetsDelete, (_event, id: unknown) => database.deleteSnippet(uuidSchema.parse(id)));

  handle(IPC.profilesList, () => database.listProfiles());
  handle(IPC.profilesSave, (_event, input: unknown) =>
    database.saveProfile(profileInputSchema.parse(input)),
  );
  handle(IPC.profilesDelete, (_event, id: unknown) => database.deleteProfile(uuidSchema.parse(id)));
  handle(IPC.scratchpadList, () => database.listScratchpadNotes());
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
      app.setLoginItemSettings(loginItemSettings(
        preview.launchAtLogin,
        process.platform,
        process.execPath,
      ));
    }
    let settings: ReturnType<LocalDatabase["getSettings"]>;
    try {
      settings = applySettingsPatchTransaction({ database, hotkeys }, patch);
    } catch (error) {
      if (launchAtLoginRequested) {
        try {
          app.setLoginItemSettings(loginItemSettings(
            previous.launchAtLogin,
            process.platform,
            process.execPath,
          ));
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
    const microphone = platform === "darwin" || platform === "win32"
      ? systemPreferences.getMediaAccessStatus("microphone")
      : "unknown";
    const accessibilityGranted = platform === "darwin"
      ? await insertion.accessibilityReady()
      : false;
    const automaticPasteReady = platform === "darwin"
      ? accessibilityGranted
      : await insertion.automaticPasteReady();
    return permissionSnapshotForPlatform(
      platform,
      microphone,
      accessibilityGranted,
      hotkeys?.isGlobalHoldReady() ?? false,
      automaticPasteReady,
    );
  });
  handle(IPC.systemGetLaunchAtLoginStatus, () => launchAtLoginStatusFor(
    process.platform,
    app.getLoginItemSettings(loginItemQueryOptions(process.platform, process.execPath)),
  ));
  handle(IPC.systemOpenPermission, async (_event, kind: unknown) => {
    const permission = z.enum(["microphone", "accessibility"]).parse(kind);
    const platform = runtimePlatformFor(process.platform);
    if (platform === "darwin" && permission === "accessibility") {
      // Prompting here registers the exact currently running signed build with
      // TCC. Merely opening the list can leave users toggling a stale entry
      // from a previous development build.
      await insertion.requestAccessibility();
      systemPreferences.isTrustedAccessibilityClient(true);
    }
    const url = permissionSettingsUrl(platform, permission);
    if (!url) throw new Error(`Opening ${permission} settings is not supported on this platform.`);
    await shell.openExternal(url);
  });
  handle(IPC.systemAppInfo, () => ({
    version: app.getVersion(),
    platform: runtimePlatformFor(process.platform),
  }));
  handle(IPC.systemDiagnostics, () => collectDiagnostics());
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
      const tier = catalog.tiers[request.tier];
      const modelRoot = modelRootForUserData(app.getPath("userData"));
      const warmSelection = worker.loadedSelection();
      const replacesLoadedArtifact = request.replaceExisting
        && warmSelection !== null
        && modelResolution !== null
        && modelResolution.tier.familyId === request.familyId
        && modelResolution.tier.artifactId === tier.artifactId
        && workerModelSelectionsMatch(warmSelection, workerSelection(modelResolution.tier));
      // Installation is a disk/network data operation, not model activation.
      // It remains available when accelerator telemetry is missing or the
      // requested tier cannot currently fit in memory. The worker stages and
      // verifies repairs before promotion; do not delete the current artifact.
      await installVerifiedModelArtifact({
        modelRoot,
        model: tier.manifest,
        replaceExisting: request.replaceExisting,
        install: () => worker.installModel(workerSelection(tier), { replacesLoadedArtifact }),
      });
      return collectDiagnostics();
    });
  });
  handle(IPC.systemRemoveModel, async (_event, rawRequest: unknown) => {
    const request = modelRemoveRequestSchema.parse(rawRequest);
    return runExclusiveModelOperation(async () => {
      assertModelSwitchAllowed();
      assertFamilyInLibrary(request.familyId);
      const tier = modelCatalog(request.familyId).tiers[request.tier];
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
      const rootStatus = await assertSafeModelRoot(modelRoot, true);
      if (rootStatus === "safe") {
        await rm(modelArtifactDirectory(modelRoot, tier.manifest), {
          recursive: true,
          force: true,
        });
      }
      // The active selection and its warm runtime are unrelated to this
      // artifact, so removal must remain a storage-only operation.
      return collectDiagnostics();
    });
  });
}

function createTray(): Tray {
  const windowsIconPath = app.isPackaged
    ? path.join(process.resourcesPath, "branding", "LocalScribe.ico")
    : path.join(app.getAppPath(), "resources", "branding", "LocalScribe.ico");
  const icon = process.platform === "win32"
    ? nativeImage.createFromPath(windowsIconPath)
    : nativeImage.createEmpty();
  const result = new Tray(icon);
  result.setTitle(process.platform === "darwin" ? "L" : "");
  result.setToolTip("LocalScribe — local dictation");
  const rebuild = () => result.setContextMenu(Menu.buildFromTemplate([
    { label: session.state === "listening" ? "Stop dictating" : "Start dictating", click: () => void (session.state === "listening" ? finishListening() : beginListening("toggle")) },
    { label: "Open LocalScribe", click: () => showHub("dictation") },
    { label: "Open Scratchpad", click: () => showScratchpad() },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
  rebuild();
  result.on("click", () => showHub("dictation"));
  result.on("right-click", rebuild);
  return result;
}

function installApplicationMenu(): void {
  if (process.platform !== "darwin") return;

  const latest = () => database.listTranscriptions(1)[0];
  const toggleShortcut = database.getSettings().toggleShortcut;
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
          label: session.state === "listening" ? "Stop Dictating" : "Start Dictating",
          accelerator: toggleShortcut,
          registerAccelerator: false,
          click: () => void (session.state === "listening" ? finishListening() : beginListening("toggle")),
        },
        {
          label: "Copy Last Transcript",
          accelerator: "CommandOrControl+Shift+C",
          enabled: Boolean(latest()),
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
        { label: `${database.listDictionary().length} dictionary entries`, enabled: false },
        { label: `${database.listSnippets().length} snippets`, enabled: false },
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

startupPromise = app.whenReady().then(async () => {
  if (!hasSingleInstanceLock || quitting) return;
  verifyPackagedResourceIntegrity({ isPackaged: app.isPackaged });
  const nativeHelperPinned = insertion.pinNativeHelperIntegrity();
  if (
    app.isPackaged
    && (process.platform === "darwin" || process.platform === "win32")
    && !nativeHelperPinned
  ) {
    throw new Error("The packaged native input helper could not be integrity-pinned.");
  }
  app.setName("LocalScribe");
  installRendererProtocol();
  runtimeModelPlatformCatalog = loadRuntimePlatformModelCatalog(runtimeModelManifestDirectory());
  database = new LocalDatabase(path.join(app.getPath("userData"), "localscribe.db"));
  databaseInitialized = true;
  database.purgeExpiredTranscriptions(database.getSettings().historyRetentionDays);
  const temporaryDirectory = app.getPath("temp");
  await cleanStaleAudioCaches(temporaryDirectory);
  if (quitting) return;
  audioCacheRoot = await createAudioCache(temporaryDirectory);
  if (quitting) return;
  const baseWorkerDirectory = app.isPackaged
    ? path.join(process.resourcesPath, "worker")
    : path.join(app.getAppPath(), "worker");
  const workerDirectory = process.platform === "win32"
    ? path.join(baseWorkerDirectory, "windows_transformers")
    : baseWorkerDirectory;
  worker = new WorkerSupervisor(
    workerDirectory,
    path.join(app.getPath("userData"), "models"),
    app.isPackaged
      ? path.join(app.getPath("userData"), "python-env")
      : path.join(app.getAppPath(), process.platform === "win32" ? ".worker-venv-windows" : ".worker-venv"),
    app.isPackaged
      ? path.join(process.resourcesPath, process.platform === "win32" ? "python-runtime-windows" : "python-runtime")
      : null,
    process.platform === "win32" ? "localscribe_windows_worker" : "localscribe_worker",
    audioCacheRoot,
  );
  workerInitialized = true;
  // Startup is an unloaded boundary. Capture one unbiased hardware snapshot;
  // later diagnostics remain observational and dictation keeps models warm.
  await refreshModelResolution({ reprobeUnloaded: true });
  // A quit request can interrupt the initial hardware probe. The shutdown
  // path waits for this promise before closing the database; do not construct
  // windows, IPC handlers, or hotkeys after that request.
  if (quitting) return;
  registerIpc();
  pillWindow = createPillWindow();
  startPillDisplayFollowing();
  if (shouldOpenSettingsAtStartup(
    process.platform,
    process.argv,
    app.getLoginItemSettings().wasOpenedAtLogin,
  )) {
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
    process.platform === "darwin"
      ? new MacControlMonitor(defaultMacControlMonitorPath({
        allowEnvironmentOverride: !app.isPackaged,
        workingDirectory: app.getAppPath(),
      }))
      : null,
    shortcutSettings.holdShortcut,
    shortcutSettings.toggleShortcut,
  );
  if (process.platform !== "darwin" || systemPreferences.isTrustedAccessibilityClient(false)) {
    try {
      hotkeys.start();
    } catch (error) {
      console.warn("Global hold-to-talk could not start", error);
      hotkeys.startFallback();
    }
  } else {
    hotkeys.startFallback();
  }
  startAccessibilityUpgradeCheck();

  app.on("activate", () => {
    showHub("dictation");
  });
});
void startupPromise.catch(async (error: unknown) => {
  if (quitting) return;
  quitting = true;
  console.error("LocalScribe startup failed", error);
  dialog.showErrorBox(
    "LocalScribe could not start",
    "The local application could not initialize. Quit LocalScribe and try opening it again.",
  );
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
    const workerShutdown = workerInitialized
      ? worker.shutdown().catch((error: unknown) => {
          console.warn("LocalScribe worker could not shut down cleanly", error);
        })
      : Promise.resolve();
    workerInitialized = false;

    // Close synchronous local state immediately. On Windows session-end the OS
    // may terminate the process before an asynchronous worker wait completes.
    if (databaseInitialized) {
      try {
        database.close();
      } catch (error) {
        console.warn("LocalScribe database could not close cleanly", error);
      }
      databaseInitialized = false;
    }
    tray?.destroy();
    tray = null;

    await workerShutdown;
    try {
      await removeAudioCache(app.getPath("temp"), audioCacheRoot);
      audioCacheRoot = null;
    } catch (error) {
      console.warn("LocalScribe temporary audio could not be removed cleanly", error);
    }
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
  if (errorDismissTimer) clearTimeout(errorDismissTimer);
  pillDisplayTimer = null;
  accessibilityTimer = null;
  errorDismissTimer = null;
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
  try {
    if (workerInitialized) worker.abort("LocalScribe is quitting");
  } catch (error) {
    console.warn("LocalScribe worker could not be aborted cleanly", error);
  }
  return true;
}
