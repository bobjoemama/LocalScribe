import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMacUpdates, type MacUpdatesDependencies } from "../src/main/updates/macUpdates";
import {
  MAC_UPDATE_FEED_NAME, MAX_FEED_BYTES, MAX_RELEASE_PAGE_BYTES, METADATA_TIMEOUT_MS,
  compareUpdateVersions, releaseAssetURL, supportedMacRelease,
} from "../src/main/updates/releaseFeed.mts";
import { appUpdateStateSchema } from "../src/shared/appUpdates";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function release(version = "0.1.0-dev.25") {
  const zip = `LocalScribe-darwin-arm64-${version}.zip`;
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/bobjoemama/LocalScribe/releases/tag/v${version}`,
    draft: false, prerelease: version.includes("-"),
    assets: [
      { name: zip, state: "uploaded", size: 100, browser_download_url: releaseAssetURL(version, zip) },
      { name: MAC_UPDATE_FEED_NAME, state: "uploaded", size: 200, browser_download_url: releaseAssetURL(version, MAC_UPDATE_FEED_NAME) },
    ],
  };
}

function feed(version = "0.1.0-dev.25") {
  return {
    version, tag: `v${version}`, name: `LocalScribe ${version}`,
    url: releaseAssetURL(version, `LocalScribe-darwin-arm64-${version}.zip`),
    notes: "Plain text release notes.\n日本語", pub_date: "2026-10-19T12:00:00Z",
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); });

function harness(overrides: Partial<MacUpdatesDependencies> = {}) {
  const events = new EventEmitter();
  const nativeStarted = deferred<void>();
  const updater = Object.assign(events, {
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(() => { nativeStarted.resolve(); events.emit("update-available"); }),
    quitAndInstall: vi.fn(),
  });
  const fetcher = vi.fn<typeof fetch>(async (url) => new Response(JSON.stringify(
    String(url).startsWith("https://api.github.com/") ? [release()] : feed(),
  )));
  const isIdle = vi.fn(() => true);
  const prepareInstall = vi.fn(async () => {});
  const deps = {
    currentVersion: "0.1.0-dev.24", platform: "darwin", arch: "arm64", isPackaged: true,
    fetch: fetcher, updater, isIdle, prepareInstall, ...overrides,
  };
  const updates = createMacUpdates(deps);
  cleanups.push(updates.dispose);
  const downloaded = (version = "0.1.0-dev.25") => events.emit("update-downloaded", {}, "notes", `LocalScribe ${version}`, new Date(), feed(version).url);
  return { updates, updater, fetcher, isIdle, prepareInstall, nativeStarted, downloaded, deps };
}

describe("Mac app update discovery", () => {
  it("checks metadata only, with anonymous bounded fetch options, including prereleases", async () => {
    const h = harness();
    const states: string[] = [];
    const unsubscribe = h.updates.subscribe((state) => { appUpdateStateSchema.parse(state); states.push(state.phase); });
    expect(await h.updates.check()).toMatchObject({ phase: "available", availableVersion: "0.1.0-dev.25" });
    expect(states).toEqual(["checking", "available"]);
    expect(h.updater.setFeedURL).not.toHaveBeenCalled();
    expect(h.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(h.fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/repos/bobjoemama/LocalScribe/releases?per_page=100&page=1",
      "https://github.com/bobjoemama/LocalScribe/releases/download/v0.1.0-dev.25/LocalScribe-macos-arm64-update.json",
    ]);
    for (const [, options] of h.fetcher.mock.calls) expect(options).toMatchObject({
      credentials: "omit", redirect: "manual", headers: { Accept: "application/json" }, signal: expect.any(AbortSignal),
    });
    unsubscribe();
  });

  it("coalesces concurrent checks and finds highest SemVer rather than publication order", async () => {
    const h = harness();
    const response = deferred<Response>();
    h.fetcher.mockImplementationOnce(() => response.promise).mockResolvedValueOnce(new Response(JSON.stringify(feed("0.1.0"))));
    const a = h.updates.check();
    expect(h.updates.check()).toBe(a);
    response.resolve(new Response(JSON.stringify([release("0.1.0-dev.100"), release("0.1.0"), release("0.1.0-dev.9")])));
    expect(await a).toMatchObject({ phase: "available", availableVersion: "0.1.0" });
  });

  it("paginates the release list instead of using /releases/latest", async () => {
    const h = harness();
    h.fetcher.mockResolvedValueOnce(new Response(JSON.stringify(Array.from({ length: 100 }, () => release("0.1.0-dev.23")))))
      .mockResolvedValueOnce(new Response(JSON.stringify([release()])))
      .mockResolvedValueOnce(new Response(JSON.stringify(feed())));
    expect((await h.updates.check()).phase).toBe("available");
    expect(h.fetcher.mock.calls[1]?.[0]).toBe("https://api.github.com/repos/bobjoemama/LocalScribe/releases?per_page=100&page=2");
  });

  it("reports an incomplete bounded scan instead of claiming the newest version is known", async () => {
    const h = harness();
    h.fetcher.mockImplementation(async () => new Response(JSON.stringify(Array.from({ length: 100 }, () => release()))));
    expect((await h.updates.check()).phase).toBe("error");
    expect(h.fetcher).toHaveBeenCalledTimes(10);
    expect(h.updater.setFeedURL).not.toHaveBeenCalled();
  });

  it.each(["0.1.0-dev.23", "0.1.0-dev.24", "0.1.0-dev.24+other"])("never offers same/older precedence %s", async (version) => {
    const h = harness();
    const value = release(version);
    value.html_url = value.html_url.replace("+", "%2B");
    h.fetcher.mockResolvedValueOnce(new Response(JSON.stringify([value])));
    expect((await h.updates.check()).phase).toBe("current");
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { platform: "linux" }, { arch: "x64" }, { isPackaged: false },
    { currentVersion: "v0.1.0" }, { currentVersion: "0.1.0-dev.01" }, { currentVersion: "garbled" },
  ])("leaves unsupported configuration untouched: %j", async (config) => {
    const h = harness(config);
    expect((await h.updates.check()).phase).toBe("unsupported");
    expect((await h.updates.downloadAndRestart()).phase).toBe("unsupported");
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.updater.eventNames()).toEqual([]);
  });

  it("ignores drafts, malformed versions, foreign repos, wrong/missing/duplicate assets", async () => {
    const wrongURL = release("0.1.0-dev.29");
    wrongURL.assets[0]!.browser_download_url += "?redirect=evil";
    const wrongArch = release("0.1.0-dev.30");
    wrongArch.assets[0]!.name = wrongArch.assets[0]!.name.replace("arm64", "x64");
    const missing = release("0.1.0-dev.31"); missing.assets.pop();
    const duplicate = release("0.1.0-dev.32"); duplicate.assets.push(duplicate.assets[0]!);
    const h = harness();
    h.fetcher.mockResolvedValueOnce(new Response(JSON.stringify([
      { ...release("0.1.0-dev.26"), draft: true },
      { ...release(), tag_name: "v0.1.0-dev.01" },
      { ...release(), html_url: "https://github.com/attacker/LocalScribe/releases/tag/v0.1.0-dev.25" },
      wrongURL, wrongArch, missing, duplicate, release(),
    ])));
    expect(await h.updates.check()).toMatchObject({ phase: "available", availableVersion: "0.1.0-dev.25" });
  });

  it.each([
    { version: "0.1.0-dev.23" }, { tag: "v0.1.0-dev.99" },
    { url: "http://github.com/bobjoemama/LocalScribe/releases/download/v0.1.0-dev.25/a.zip" },
    { url: "https://github.com/attacker/LocalScribe/releases/download/v0.1.0-dev.25/a.zip" },
    { url: `${feed().url}?anything=true` }, { url: `https://github.com@evil.test/a.zip` },
    { name: "other release" }, { notes: "nul\u0000" }, { pub_date: "not-a-date" }, { unexpected: true },
  ])("rejects mismatched/malformed static feed %j before native check", async (patch) => {
    const h = harness();
    h.fetcher.mockResolvedValueOnce(new Response(JSON.stringify([release()])))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...feed(), ...patch })));
    expect((await h.updates.check()).phase).toBe("error");
    await h.updates.downloadAndRestart();
    expect(h.updater.setFeedURL).not.toHaveBeenCalled();
  });

  it.each(["offline", "malformed", "http", "oversized"])("handles %s metadata and recovers on a later check", async (mode) => {
    const h = harness();
    if (mode === "offline") h.fetcher.mockRejectedValueOnce(new Error("private-path must not escape"));
    else if (mode === "malformed") h.fetcher.mockResolvedValueOnce(new Response("{"));
    else if (mode === "http") h.fetcher.mockResolvedValueOnce(new Response("rate limited", { status: 403 }));
    else h.fetcher.mockResolvedValueOnce(new Response("[]", { headers: { "content-length": String(MAX_RELEASE_PAGE_BYTES + 1) } }));
    expect(await h.updates.check()).toMatchObject({ phase: "error", message: "Could not check for updates. Check the connection and try again." });
    expect((await h.updates.check()).phase).toBe("available");
  });

  it("enforces streaming byte limits even without content-length", async () => {
    const h = harness();
    h.fetcher.mockResolvedValueOnce(new Response(JSON.stringify([release()])))
      .mockResolvedValueOnce(new Response(new Uint8Array(MAX_FEED_BYTES + 1)));
    expect((await h.updates.check()).phase).toBe("error");
  });

  it("times out metadata and aborts the actual request using virtual time", async () => {
    vi.useFakeTimers();
    const started = deferred<AbortSignal>();
    const h = harness({ fetch: vi.fn(async (_url, options) => {
      const signal = options!.signal!;
      started.resolve(signal);
      return await new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }) });
    const pending = h.updates.check();
    const signal = await started.promise;
    await vi.advanceTimersByTimeAsync(METADATA_TIMEOUT_MS);
    expect((await pending).phase).toBe("error");
    expect(signal.aborted).toBe(true);
  });

  it("follows only GitHub asset CDN redirects and rejects API redirects", async () => {
    const h = harness();
    h.fetcher.mockResolvedValueOnce(new Response(JSON.stringify([release()])))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/github-production-release-asset/123/abc?sig=temporary" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(feed())));
    expect((await h.updates.check()).phase).toBe("available");
    h.fetcher.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://evil.test/list" } }));
    expect((await h.updates.check()).phase).toBe("error");
  });
});

describe("Mac app update native lifecycle", () => {
  it("starts only after explicit idle approval, coalesces clicks, and waits for shutdown before native install", async () => {
    const gate = deferred<void>();
    const preparing = deferred<void>();
    const h = harness({ prepareInstall: vi.fn(async () => { preparing.resolve(); await gate.promise; }) });
    await h.updates.check();
    const action = h.updates.downloadAndRestart();
    expect(h.updates.downloadAndRestart()).toBe(action);
    await h.nativeStarted.promise;
    expect(h.updater.setFeedURL).toHaveBeenCalledExactlyOnceWith({
      url: releaseAssetURL("0.1.0-dev.25", MAC_UPDATE_FEED_NAME), serverType: "default", headers: { Accept: "application/json" },
    });
    h.downloaded();
    await preparing.promise;
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled();
    gate.resolve();
    expect((await action).phase).toBe("installing");
    expect(h.updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("allows dictation during download and defers restart until a later explicit idle click", async () => {
    const h = harness();
    await h.updates.check();
    const action = h.updates.downloadAndRestart();
    await h.nativeStarted.promise;
    h.isIdle.mockReturnValue(false);
    h.downloaded();
    expect(await action).toMatchObject({ phase: "ready", message: expect.stringContaining("next normal quit") });
    expect(h.prepareInstall).not.toHaveBeenCalled();
    expect((await h.updates.check()).phase).toBe("ready");
    h.isIdle.mockReturnValue(true);
    expect((await h.updates.downloadAndRestart()).phase).toBe("installing");
    expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("refuses a busy download and rechecks idle after async feed validation", async () => {
    const h = harness();
    await h.updates.check();
    h.isIdle.mockReturnValue(false);
    expect((await h.updates.downloadAndRestart()).phase).toBe("available");
    expect(h.updater.checkForUpdates).not.toHaveBeenCalled();
    h.isIdle.mockReturnValue(true);
    const request = deferred<void>(); const response = deferred<Response>();
    h.fetcher.mockImplementationOnce(async () => { request.resolve(); return response.promise; });
    const action = h.updates.downloadAndRestart();
    await request.promise;
    h.isIdle.mockReturnValue(false);
    response.resolve(new Response(JSON.stringify(feed())));
    expect((await action).phase).toBe("available");
    expect(h.updater.setFeedURL).not.toHaveBeenCalled();
  });

  it("keeps ready if the parent's atomic idle lease loses the race", async () => {
    const h = harness({ prepareInstall: vi.fn(async () => { throw new Error("busy now"); }) });
    await h.updates.check();
    const action = h.updates.downloadAndRestart();
    await h.nativeStarted.promise;
    h.downloaded();
    const outcome = await action;
    expect(outcome.phase).toBe("ready");
    expect(outcome.message).toContain("Save or close pending work");
    expect(outcome.message).not.toContain("busy now");
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("validates the feed again before starting a native download", async () => {
    const h = harness();
    await h.updates.check();
    h.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...feed(), url: "https://evil.test/archive.zip" })));
    expect((await h.updates.downloadAndRestart()).phase).toBe("error");
    expect(h.updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("ignores unsolicited downloaded events and rejects a mismatched native ZIP", async () => {
    const h = harness();
    h.downloaded();
    expect(h.updates.getState().phase).toBe("idle");
    await h.updates.check();
    const action = h.updates.downloadAndRestart();
    await h.nativeStarted.promise;
    h.downloaded("0.1.0-dev.26");
    expect((await action).phase).toBe("error");
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it.each(["error", "update-not-available"])("cleans up on native %s and will not retry an uncorrelatable session", async (event) => {
    const h = harness();
    await h.updates.check();
    const action = h.updates.downloadAndRestart();
    await h.nativeStarted.promise;
    h.updater.emit(event, new Error("private diagnostic"));
    expect((await action).phase).toBe("error");
    h.downloaded();
    await h.updates.check();
    expect(await h.updates.downloadAndRestart()).toMatchObject({ phase: "error", message: expect.stringContaining("Relaunch") });
    expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it.each(["setFeedURL", "checkForUpdates"] as const)("handles a synchronous native %s failure", async (method) => {
    const h = harness();
    await h.updates.check();
    h.updater[method].mockImplementationOnce(() => { throw new Error("native failure"); });
    expect((await h.updates.downloadAndRestart()).phase).toBe("error");
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it.each(["throw", "event"])("reports a native installation failure after cleanup: %s", async (mode) => {
    const h = harness();
    h.updater.quitAndInstall.mockImplementation(() => {
      if (mode === "throw") throw new Error("install failure");
      h.updater.emit("error", new Error("install failure"));
    });
    await h.updates.check();
    const action = h.updates.downloadAndRestart();
    await h.nativeStarted.promise; h.downloaded();
    expect((await action).phase).toBe("error");
    expect(h.prepareInstall).toHaveBeenCalledTimes(1);
  });

  it("disposal during download drains late native errors without restarting or notifying", async () => {
    const h = harness();
    const listener = vi.fn(); h.updates.subscribe(listener);
    await h.updates.check();
    const action = h.updates.downloadAndRestart();
    await h.nativeStarted.promise;
    h.updates.dispose(); listener.mockClear();
    await action;
    h.updater.emit("error", new Error("late failure"));
    h.downloaded();
    expect(h.updater.eventNames()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("disposal while shutdown prepares prevents a late restart", async () => {
    const gate = deferred<void>(); const preparing = deferred<void>();
    const h = harness({ prepareInstall: async () => { preparing.resolve(); await gate.promise; } });
    await h.updates.check();
    const action = h.updates.downloadAndRestart();
    await h.nativeStarted.promise; h.downloaded(); await preparing.promise;
    h.updates.dispose(); gate.resolve(); await action;
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(h.updater.eventNames()).toEqual([]);
  });

  it.each(["ready", "installing"])("disposal from the %s notification releases listeners and prevents restart", async (phase) => {
    const h = harness();
    h.updates.subscribe((state) => { if (state.phase === phase) h.updates.dispose(); });
    await h.updates.check();
    const action = h.updates.downloadAndRestart();
    await h.nativeStarted.promise; h.downloaded(); await action;
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(h.updater.eventNames()).toEqual([]);
  });

  it("disposal from the downloading notification prevents a native request and releases listeners", async () => {
    const h = harness();
    h.updates.subscribe((state) => { if (state.phase === "downloading") h.updates.dispose(); });
    await h.updates.check(); await h.updates.downloadAndRestart();
    expect(h.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(h.updater.eventNames()).toEqual([]);
  });

  it("aborts an in-progress metadata request on dispose without a late state notification", async () => {
    const started = deferred<AbortSignal>();
    const h = harness({ fetch: async (_url, init) => {
      const signal = init!.signal!; started.resolve(signal);
      return await new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } });
    const notify = vi.fn(); h.updates.subscribe(notify);
    const check = h.updates.check(); const signal = await started.promise;
    h.updates.dispose(); notify.mockClear(); await check;
    expect(signal.aborted).toBe(true); expect(notify).not.toHaveBeenCalled();
    expect(h.updater.eventNames()).toEqual([]);
  });

  it("returns isolated state snapshots and survives a failed subscriber", async () => {
    const h = harness();
    h.updates.subscribe(() => { throw new Error("renderer gone"); });
    const first = h.updates.getState(); first.phase = "error";
    expect(h.updates.getState().phase).toBe("idle");
    expect((await h.updates.check()).phase).toBe("available");
  });

  it("disposal from a checking-state subscriber prevents a new network request", async () => {
    const h = harness();
    h.updates.subscribe(() => h.updates.dispose());
    await h.updates.check();
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.updater.eventNames()).toEqual([]);
  });
});

describe("update version and release protocol", () => {
  it.each([
    ["0.1.0-dev.10", "0.1.0-dev.9", 1], ["0.1.0", "0.1.0-dev.99", 1],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta", -1], ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-beta.11", "1.0.0-rc.1", -1], ["1.0.0+abc", "1.0.0+xyz", 0],
    ["99999999999999999.0.0", "99999999999999998.0.0", 1],
  ])("compares %s with %s using SemVer precedence", (left, right, expected) => {
    expect(compareUpdateVersions(left, right)).toBe(expected);
  });

  it.each(["v1.0.0", "1.0", "01.0.0", "1.0.0-01", "1.0.0-..", "1.0.0-日本語", "1.0.0\n"])("rejects unsupported version %j", (version) => {
    expect(() => compareUpdateVersions(version, "1.0.0")).toThrow();
  });

  it("requires the exact release identity and uploaded asset state", () => {
    const value = release(); value.assets[0]!.state = "new";
    expect(supportedMacRelease(value)).toBeUndefined();
    expect(supportedMacRelease(release())).toMatchObject({ version: "0.1.0-dev.25" });
  });
});
