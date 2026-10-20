import type { AppUpdateState } from "../../shared/appUpdates";
import {
  compareUpdateVersions,
  MAX_FEED_BYTES,
  MAX_RELEASE_PAGE_BYTES,
  MAX_RELEASE_PAGES,
  METADATA_TIMEOUT_MS,
  supportedMacRelease,
  UPDATE_REPOSITORY,
  updateVersionSchema,
  validateMacUpdateFeed,
  type MacUpdateRelease,
} from "./releaseFeed.mts";

type UpdateListener = (...args: unknown[]) => void;
export interface MacNativeUpdater {
  setFeedURL(options: { url: string; serverType: "default"; headers: Record<string, string> }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
  on(event: string, listener: UpdateListener): unknown;
  removeListener(event: string, listener: UpdateListener): unknown;
}

export interface MacUpdatesDependencies {
  currentVersion: string;
  platform: string;
  arch: string;
  isPackaged: boolean;
  fetch: typeof globalThis.fetch;
  updater: MacNativeUpdater;
  isIdle(): boolean;
  /** Acquire the idle lease atomically, retire runtime resources, and keep the lease through quitAndInstall. Reject on failure/busy. */
  prepareInstall(): Promise<void>;
}

const stagedMessage = "The update is ready. Restart to update when idle, or it will install on the next normal quit.";

/** Release-asset redirects are controlled by GitHub, with no app/user identifiers or credentials sent. */
function isGitHubAssetRedirect(url: string): boolean {
  const target = new URL(url);
  return target.protocol === "https:" && !target.username && !target.password && !target.port
    && !target.hash && (target.hostname === "release-assets.githubusercontent.com" || target.hostname === "objects.githubusercontent.com")
    && target.pathname.startsWith("/github-production-release-asset/");
}

async function readJSON(
  fetcher: typeof globalThis.fetch,
  url: string,
  maxBytes: number,
  signal: AbortSignal,
  asset = false,
): Promise<unknown> {
  let target = url;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    signal.throwIfAborted();
    const response = await fetcher(target, {
      signal,
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!asset || !location || !isGitHubAssetRedirect(location)) throw new Error("Invalid update metadata redirect.");
      target = location;
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error("Update metadata request failed.");
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) {
      await response.body?.cancel();
      throw new Error("Update metadata exceeds the byte limit.");
    }
    if (!response.body) throw new Error("Missing update metadata.");
    const reader = response.body.getReader();
    const data = Buffer.allocUnsafe(maxBytes);
    let bytes = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        if (bytes + value.byteLength > maxBytes) throw new Error("Update metadata exceeds the byte limit.");
        data.set(value, bytes);
        bytes += value.byteLength;
      }
      signal.throwIfAborted();
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, bytes))) as unknown;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  throw new Error("Too many update metadata redirects.");
}

/**
 * Metadata checks never invoke native autoUpdater (which downloads immediately).
 * Squirrel owns signing validation, staging and installation. Its native refetch
 * and redirects cannot be pinned to JS-validated bytes; it buffers ZIPs and does
 * not enforce archive SHA-256/size. Only explicitly approved downloads reach it.
 */
export function createMacUpdates(deps: MacUpdatesDependencies) {
  let disposed = false;
  const supported = deps.platform === "darwin" && deps.arch === "arm64" && deps.isPackaged
    && updateVersionSchema.safeParse(deps.currentVersion).success;
  let state: AppUpdateState = {
    phase: supported ? "idle" : "unsupported",
    currentVersion: deps.currentVersion,
    ...(!supported ? { message: "In-app updates require a packaged Apple Silicon Mac app with a supported version." } : {}),
  };
  const listeners = new Set<(state: AppUpdateState) => void>();
  let selected: MacUpdateRelease | undefined;
  let checkFlight: Promise<AppUpdateState> | undefined;
  let actionFlight: Promise<AppUpdateState> | undefined;
  let request: AbortController | undefined;
  let nativeAttempted = false;
  let nativeActive = false;
  let nativeAvailable = false;
  let installStarted = false;
  let finishDownload: (() => void) | undefined;

  const getState = (): AppUpdateState => ({ ...state });
  const publish = (phase: AppUpdateState["phase"], message?: string) => {
    if (disposed) return;
    state = { phase, currentVersion: deps.currentVersion,
      ...(selected ? { availableVersion: selected.version } : {}), ...(message ? { message } : {}) };
    for (const listener of listeners) {
      // A renderer notification failure must not change update/installation state.
      try { listener(getState()); } catch { /* The subscriber owns its delivery failure. */ }
    }
  };

  const withMetadata = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    request = controller;
    const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);
    try { return await operation(controller.signal); }
    finally {
      clearTimeout(timer);
      if (request === controller) request = undefined;
    }
  };

  const validateFeed = async (release: MacUpdateRelease, signal: AbortSignal) => {
    validateMacUpdateFeed(await readJSON(deps.fetch, release.feedURL, MAX_FEED_BYTES, signal, true), release);
  };

  const check = (): Promise<AppUpdateState> => {
    if (disposed || !supported || ["downloading", "ready", "installing"].includes(state.phase) || actionFlight) return Promise.resolve(getState());
    if (checkFlight) return checkFlight;
    checkFlight = Promise.resolve().then(async () => {
      if (disposed) return getState();
      selected = undefined;
      publish("checking");
      if (disposed) return getState();
      try {
        const newest = await withMetadata(async (signal) => {
          let newest: MacUpdateRelease | undefined;
          for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
            const raw = await readJSON(deps.fetch,
              `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=100&page=${page}`,
              MAX_RELEASE_PAGE_BYTES, signal);
            if (!Array.isArray(raw) || raw.length > 100) throw new Error("Invalid release list.");
            for (const item of raw) {
              const release = supportedMacRelease(item);
              if (release && compareUpdateVersions(release.version, deps.currentVersion) > 0
                && (!newest || compareUpdateVersions(release.version, newest.version) > 0)) newest = release;
            }
            if (raw.length < 100) {
              if (newest) await validateFeed(newest, signal);
              return newest;
            }
          }
          // A bounded, incomplete scan cannot honestly report the newest version.
          throw new Error("Release list exceeds the discovery limit.");
        });
        if (!disposed) {
          selected = newest;
          publish(newest ? "available" : "current", newest ? "An update is available. Download and restart when idle." : "LocalScribe is up to date.");
        }
      } catch {
        publish("error", "Could not check for updates. Check the connection and try again.");
      }
      return getState();
    }).finally(() => { checkFlight = undefined; });
    return checkFlight;
  };

  const completeNative = (terminal = false) => {
    nativeActive = false;
    const finish = finishDownload;
    finishDownload = undefined;
    finish?.();
    if (terminal && disposed) detachNativeListeners();
  };
  const onAvailable: UpdateListener = () => {
    if (!disposed && nativeActive) nativeAvailable = true;
  };
  const onDownloaded: UpdateListener = (...args) => {
    if (disposed) { detachNativeListeners(); return; }
    if (!nativeActive || !nativeAvailable || !selected) return;
    // Electron passes (event, releaseNotes, releaseName, releaseDate, updateURL).
    if (args[4] !== selected.zipURL || args[2] !== `LocalScribe ${selected.version}`) {
      publish("error", "The downloaded update did not match the approved release. Relaunch LocalScribe before retrying.");
    } else publish("ready", stagedMessage);
    completeNative(true);
  };
  const onError: UpdateListener = () => {
    if (disposed) { detachNativeListeners(); return; }
    if (!nativeActive && state.phase !== "installing") return;
    installStarted = false;
    publish("error", "The update could not be completed. Relaunch LocalScribe before retrying.");
    completeNative(true);
  };
  const onNotAvailable: UpdateListener = () => {
    if (disposed) { detachNativeListeners(); return; }
    if (!nativeActive) return;
    publish("error", "The approved update is no longer available. Relaunch LocalScribe before retrying.");
    completeNative(true);
  };
  const nativeListeners: [string, UpdateListener][] = [
    ["update-available", onAvailable], ["update-downloaded", onDownloaded],
    ["update-not-available", onNotAvailable], ["error", onError],
  ];
  const detachNativeListeners = () => {
    if (supported) for (const [event, listener] of nativeListeners) deps.updater.removeListener(event, listener);
  };
  if (supported) for (const [event, listener] of nativeListeners) deps.updater.on(event, listener);

  const installReady = async () => {
    if (disposed || state.phase !== "ready") return;
    if (!deps.isIdle()) { publish("ready", stagedMessage); return; }
    try {
      await deps.prepareInstall();
      if (disposed || state.phase !== "ready") return;
      publish("installing", "Restarting LocalScribe to install the update.");
      if (!disposed && getState().phase === "installing") {
        installStarted = true;
        deps.updater.quitAndInstall();
      }
    } catch {
      installStarted = false;
      if (getState().phase === "installing") publish("error", "Could not restart to install the update. It remains staged for the next normal quit.");
      else publish("ready", "Save or close pending work in Settings and Notes before choosing Restart to update again. The update remains staged for the next normal quit.");
    }
  };

  const downloadAndRestart = (): Promise<AppUpdateState> => {
    if (disposed || !supported) return Promise.resolve(getState());
    if (actionFlight) return actionFlight;
    actionFlight = Promise.resolve().then(async () => {
      if (checkFlight) await checkFlight;
      if (disposed) return getState();
      if (state.phase === "ready") { await installReady(); return getState(); }
      if (!selected || state.phase !== "available") return getState();
      if (nativeAttempted) {
        publish("error", "Relaunch LocalScribe before retrying the download.");
        return getState();
      }
      if (!deps.isIdle()) {
        publish("available", "Finish dictation and other active work before starting the update download.");
        return getState();
      }
      try {
        // Check the static feed again immediately before handing it to Squirrel.
        await withMetadata((signal) => validateFeed(selected!, signal));
        if (disposed) return getState();
        if (!deps.isIdle()) {
          publish("available", "Finish dictation and other active work before starting the update download.");
          return getState();
        }
        nativeAttempted = true;
        nativeAvailable = false;
        nativeActive = true;
        const completed = new Promise<void>((resolve) => { finishDownload = resolve; });
        publish("downloading", "Downloading the update. Dictation can continue; the downloaded update also installs on the next normal quit.");
        if (disposed) { completeNative(true); return getState(); }
        deps.updater.setFeedURL({ url: selected.feedURL, serverType: "default", headers: { Accept: "application/json" } });
        if (nativeActive && !disposed) deps.updater.checkForUpdates();
        await completed;
        await installReady();
      } catch {
        completeNative();
        publish("error", nativeAttempted
          ? "The update could not be completed. Relaunch LocalScribe before retrying."
          : "Could not validate the update feed. Check the connection and try again.");
      }
      return getState();
    }).finally(() => { actionFlight = undefined; });
    return actionFlight;
  };

  return {
    getState, check, downloadAndRestart,
    subscribe(listener: (state: AppUpdateState) => void): () => void {
      if (!disposed) listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      request?.abort();
      listeners.clear();
      // Native downloads cannot be cancelled. Drain the terminal event so a late
      // EventEmitter 'error' is handled, then detach without restarting the app.
      if (!nativeActive && !installStarted) detachNativeListeners();
      completeNative();
    },
  };
}
