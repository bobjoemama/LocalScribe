import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
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
  MODEL_FAMILY_IDS,
  modelFamilyLibraryRequestSchema,
  modelInstallRequestSchema,
  modelRemoveRequestSchema,
  navigationTargetSchema,
  pillModeSchema,
  sessionSnapshotSchema,
  snippetSchema,
  transcribeAudioSchema,
  type Diagnostics,
  type ModelCatalog,
  type ModelFamilyId,
  type ModelPerformanceTier,
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
  type WorkerAcceleratorSnapshot,
  type WorkerComputeType,
  type WorkerModelSelection,
} from "./main/worker/workerSupervisor";
import { HotkeyService } from "./main/hotkeys/hotkeyService";
import { defaultMacControlMonitorPath, MacControlMonitor } from "./main/hotkeys/macControlMonitor";
import { InsertionService } from "./main/insertion/insertionService";
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
  permissionSettingsUrl,
  permissionSnapshotForPlatform,
  runtimePlatformFor,
} from "./main/platformCapabilities";
import {
  PILL_HOVER_HIT_PADDING,
  PILL_LAYOUT,
  PILL_WINDOW_BOTTOM_MARGIN,
  pillSizeFor,
} from "./shared/pillLayout";
import {
  RENDERER_PROTOCOL_HOST,
  RENDERER_PROTOCOL_SCHEME,
  rendererUrlForSurface,
  resolvePackagedRendererPath,
  type RendererSurface,
} from "./main/rendererProtocol";

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
let pillMode: PillMode = "collapsed";
// Environment-selected executable helpers are a useful development seam, but
// must never override the helper bundled into a packaged application.
const insertion = new InsertionService({
  allowNativeHelperEnvironmentOverride: !app.isPackaged,
});
let session: SessionSnapshot = { state: "idle" };
let quitting = false;
let runtimeModelPlatformCatalog: RuntimePlatformModelCatalog | null = null;
let modelResolution: ModelPerformanceResolution | null = null;
let previousAutoTier: ModelPerformanceTier | undefined;
let activeDictationTier: ModelPerformanceTier | undefined;
let activeSessionId: string | null = null;
let acceleratorSnapshot: WorkerAcceleratorSnapshot | null = null;
let modelOperationTail: Promise<void> = Promise.resolve();
let modelOperationCount = 0;
// Squirrel must process install/update/uninstall lifecycle events before the
// app acquires its normal instance lock or creates any windows/tray state.
const squirrelStartup = Boolean(createRequire(import.meta.url)("electron-squirrel-startup"));
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
  return session.state === "idle" || session.state === "success" || session.state === "error";
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

/** Returns static packaged metadata only; it intentionally does not probe hardware or the worker. */
function collectModelCatalog(): ModelCatalog {
  const settings = database.getSettings();
  const catalog = platformModelCatalog();
  return {
    platform: catalog.platform,
    activeModelFamilyId: settings.activeModelFamilyId,
    modelLibraryFamilyIds: settings.modelLibraryFamilyIds,
    families: MODEL_FAMILY_IDS.map((familyId) => {
      const family = catalog.families[familyId];
      const artifacts = new Map<string, RuntimeModelTierSpec>();
      for (const tier of Object.values(family.tiers)) artifacts.set(tier.artifactId, tier);
      return {
        familyId,
        displayName: family.displayName,
        active: familyId === settings.activeModelFamilyId,
        inLibrary: settings.modelLibraryFamilyIds.includes(familyId),
        artifacts: [...artifacts.values()].map((tier) => ({
          artifactId: tier.artifactId,
          displayName: tier.manifest.displayName,
          backend: tier.manifest.backend,
          modelId: tier.manifest.modelId,
          storageDirectory: tier.manifest.storageDirectory,
          revision: tier.manifest.revision,
          license: tier.manifest.license,
          expectedDownloadBytes: tier.expectedDownloadBytes,
        })),
        profiles: Object.values(family.tiers).map((tier) => ({
          profileId: tier.profileId,
          tier: tier.tier,
          artifactId: tier.artifactId,
          engine: tier.engine,
          precision: tier.precision,
          expectedMemoryMinBytes: tier.acceleratorMemory.minimumBytes,
          expectedMemoryMaxBytes: tier.acceleratorMemory.maximumBytes,
          memoryBasis: tier.acceleratorMemory.evidence.kind,
        })),
      };
    }),
  };
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

async function refreshModelResolution(): Promise<ModelPerformanceResolution> {
  // Hardware-driven Auto may only move at an idle boundary. During dictation
  // the previously selected tier remains pinned from recording through insert.
  if (session.state === "idle") {
    // Probe an unloaded device so Auto is not biased downward by the memory
    // consumed by whichever tier happened to run most recently.
    await worker.shutdown();
    try {
      acceleratorSnapshot = await worker.deviceInfo();
    } catch (error) {
      acceleratorSnapshot = null;
      console.warn("Accelerator diagnostics are unavailable", error);
    }
  }
  const preference = database.getSettings().modelPerformanceMode;
  const next = resolveModelPerformance({
    preference,
    catalog: modelCatalog(),
    memory: memorySnapshot(),
    previousTier: previousAutoTier,
    activeDictationTier,
  });
  modelResolution = next;
  if (session.state === "idle" && preference === "auto" && next.fitsMemoryBudget) {
    previousAutoTier = next.effectiveTier;
  }
  return next;
}

async function currentModelResolution(): Promise<ModelPerformanceResolution> {
  if (session.state === "idle" || !modelResolution) return refreshModelResolution();
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

async function collectDiagnostics(): Promise<Diagnostics> {
  const resolution = await currentModelResolution();
  const modelRoot = path.join(app.getPath("userData"), "models");
  const catalog = modelCatalog();
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

function rendererUrl(surface: RendererSurface): string {
  return rendererUrlForSurface(surface, MAIN_WINDOW_VITE_DEV_SERVER_URL);
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
    width: 1220,
    height: 760,
    minWidth: 900,
    minHeight: 640,
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
    if (!hotkeys || !systemPreferences.isTrustedAccessibilityClient(false)) return;
    try {
      hotkeys.start();
    } catch (error) {
      console.warn("Global hold-to-talk could not start after Accessibility changed", error);
      hotkeys.startFallback();
    }
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
    if (window && !window.isDestroyed()) window.webContents.send(IPC.settingsChanged, settings);
  }
}

/**
 * Family membership and activation have dedicated main-owned operations so a
 * renderer cannot repoint the runtime through an arbitrary whole-settings
 * write. Performance preference remains an independent setting.
 */
function assertGenericSettingsPreserveModelLibrary(
  previous: ReturnType<LocalDatabase["getSettings"]>,
  next: Pick<ReturnType<LocalDatabase["getSettings"]>, "activeModelFamilyId" | "modelLibraryFamilyIds">,
): void {
  if (
    next.activeModelFamilyId !== previous.activeModelFamilyId
    || next.modelLibraryFamilyIds.join("\u0000") !== previous.modelLibraryFamilyIds.join("\u0000")
  ) {
    throw new Error("Use the model library operations to add or activate a local speech model family.");
  }
}

function beginListening(activation: "hold" | "toggle" = "toggle"): SessionSnapshot {
  if (session.state !== "idle" && session.state !== "success" && session.state !== "error") return session;
  if (modelOperationInProgress()) {
    return failSession("Wait for the local model operation to finish before dictating.");
  }
  if (!modelResolution) {
    return failSession("Local model selection is still initializing. Try dictating again in a moment.");
  }
  try {
    assertResolutionFitsMemory(modelResolution);
  } catch (error) {
    return failSession(error);
  }
  const sessionId = randomUUID();
  activeSessionId = sessionId;
  activeDictationTier = modelResolution.effectiveTier;
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

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url;
  if (!url) throw new Error("Rejected IPC without a sender frame");
  const trusted = (["settings", "pill", "scratchpad"] as const).some((surface) => url === rendererUrl(surface));
  if (!trusted) throw new Error("Rejected IPC from an untrusted renderer");
}

function registerIpc(): void {
  const handle = <T extends unknown[]>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: T) => unknown,
  ) => {
    ipcMain.handle(channel, (event, ...args: T) => {
      assertTrustedSender(event);
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
    const cacheRoot = path.join(app.getPath("temp"), "localscribe-audio");
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
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
      const terms = database
        .listDictionary()
        .map((entry) => `${entry.phrase}=${entry.replacement}`)
        .join(", ");
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
        database.listDictionary(),
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
        const automaticPasteReady = process.platform === "darwin"
          ? await insertion.accessibilityReady()
          : process.platform === "win32";
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
    const previous = database.getSettings();
    const preview = appSettingsSchema.parse({ ...previous, ...patch });
    assertGenericSettingsPreserveModelLibrary(previous, preview);
    const modelPreferenceChanged = preview.modelPerformanceMode !== previous.modelPerformanceMode;
    if (modelPreferenceChanged) assertModelSwitchAllowed();
    const settings = applySettingsPatchTransaction({ database, hotkeys }, patch);
    if (modelPreferenceChanged) {
      await worker.shutdown();
      modelResolution = null;
      await refreshModelResolution();
    }
    const purged = database.purgeExpiredTranscriptions(settings.historyRetentionDays);
    if (purged > 0) notifyHistoryChanged();
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
    syncPillVisibility();
    installApplicationMenu();
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
    installApplicationMenu();
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
    return permissionSnapshotForPlatform(
      platform,
      microphone,
      accessibilityGranted,
      hotkeys?.isGlobalHoldReady() ?? false,
    );
  });
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
  handle(IPC.systemAddModelFamily, (_event, rawRequest: unknown) => {
    const request = modelFamilyLibraryRequestSchema.parse(rawRequest);
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
  handle(IPC.systemActivateModelFamily, async (_event, rawRequest: unknown) => {
    const request = modelFamilyLibraryRequestSchema.parse(rawRequest);
    return runExclusiveModelOperation(async () => {
      assertModelSwitchAllowed();
      assertFamilyInLibrary(request.familyId);
      const previous = database.getSettings();
      if (previous.activeModelFamilyId === request.familyId) return collectModelCatalog();
      // A fresh worker process is our cross-engine unload boundary. Persist
      // only after the old runtime has been shut down.
      await worker.shutdown();
      const settings = database.saveSettings(appSettingsSchema.parse({
        ...previous,
        activeModelFamilyId: request.familyId,
      }));
      previousAutoTier = undefined;
      modelResolution = null;
      await refreshModelResolution();
      notifySettingsChanged(settings);
      return collectModelCatalog();
    });
  });
  handle(IPC.systemInstallModel, async (_event, rawRequest: unknown) => {
    const request = modelInstallRequestSchema.parse(rawRequest);
    return runExclusiveModelOperation(async () => {
      assertModelSwitchAllowed();
      assertFamilyInLibrary(request.familyId);
      if (session.state === "idle") await refreshModelResolution();
      const catalog = modelCatalog(request.familyId);
      const tier = catalog.tiers[request.tier];
      const requestedResolution = resolveModelPerformance({
        preference: request.tier,
        catalog,
        memory: memorySnapshot(),
      });
      assertResolutionFitsMemory(requestedResolution);
      if (request.replaceExisting) {
        // Repair intentionally does not delete the current artifact. The
        // worker stages and verifies a replacement before it swaps an invalid
        // directory, so an interrupted repair cannot discard the only copy.
        await worker.shutdown();
      }
      await worker.ensureReady(workerSelection(tier), { allowDownload: true });
      return collectDiagnostics();
    });
  });
  handle(IPC.systemRemoveModel, async (_event, rawRequest: unknown) => {
    const request = modelRemoveRequestSchema.parse(rawRequest);
    return runExclusiveModelOperation(async () => {
      assertModelSwitchAllowed();
      assertFamilyInLibrary(request.familyId);
      await worker.shutdown();
      const tier = modelCatalog(request.familyId).tiers[request.tier];
      await rm(path.join(app.getPath("userData"), "models", tier.manifest.storageDirectory), {
        recursive: true,
        force: true,
      });
      modelResolution = null;
      if (session.state === "idle") await refreshModelResolution();
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

async function cleanStaleAudio(): Promise<void> {
  const root = path.join(app.getPath("temp"), "localscribe-audio");
  try {
    const entries = await readdir(root);
    await Promise.all(entries.filter((entry) => entry.endsWith(".wav")).map((entry) => rm(path.join(root, entry), { force: true })));
  } catch {
    // The directory does not exist on first launch.
  }
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  app.setName("LocalScribe");
  installRendererProtocol();
  runtimeModelPlatformCatalog = loadRuntimePlatformModelCatalog(runtimeModelManifestDirectory());
  database = new LocalDatabase(path.join(app.getPath("userData"), "localscribe.db"));
  database.purgeExpiredTranscriptions(database.getSettings().historyRetentionDays);
  await cleanStaleAudio();
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
  );
  await refreshModelResolution();
  registerIpc();
  pillWindow = createPillWindow();
  startPillDisplayFollowing();
  if (!app.getLoginItemSettings().wasOpenedAtLogin) settingsWindow = createSettingsWindow();
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

app.on("second-instance", () => {
  showHub("dictation");
});

app.on("window-all-closed", () => {
  // The pill and global dictation service keep the app resident.
});

app.on("before-quit", (event) => {
  if (quitting || !worker) return;
  event.preventDefault();
  quitting = true;
  if (pillDisplayTimer) clearInterval(pillDisplayTimer);
  if (accessibilityTimer) clearInterval(accessibilityTimer);
  if (errorDismissTimer) clearTimeout(errorDismissTimer);
  pillDisplayTimer = null;
  accessibilityTimer = null;
  errorDismissTimer = null;
  hotkeys?.stop();
  worker.abort("LocalScribe is quitting");
  database.close();
  app.exit(0);
});
