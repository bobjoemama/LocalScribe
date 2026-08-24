import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { expectPrecedes, sliceBetween } from "./support/order";

const main = readFileSync("src/main.ts", "utf8");
const styleSettings = readFileSync("src/renderer/settings/screens/StyleSettings.tsx", "utf8");

describe("session-transition lifecycle ordering", () => {
  const transition = sliceBetween(main, "function setSession(", "function failSession(");

  it("arms both state-owned timers before fallible presentation work", () => {
    expectPrecedes(transition, "session = sessionSnapshotSchema.parse", "finalizeWatchdog.observe");
    expectPrecedes(transition, "finalizeWatchdog.observe", "resizePill()");
    expectPrecedes(transition, "noticeTimer.observe", "sendToLiveRenderers(");
    expectPrecedes(transition, "noticeTimer.observe", "syncPillVisibility()");
  });

  it("uses the teardown-safe central renderer broadcaster", () => {
    expect(transition).toContain("sendToLiveRenderers(");
    expect(transition).not.toContain("window.webContents.send");
  });
});

describe("renderer crash recovery integration", () => {
  const handlers = sliceBetween(
    main,
    "function installRendererFailureHandlers(",
    "function hideWindowInsteadOfClosing(",
  );

  it("handles both navigation failure and renderer-process loss", () => {
    expect(handlers).toContain('contents.on("did-fail-load"');
    expect(handlers).toContain('contents.on("render-process-gone"');
    expect(handlers).toContain("rendererFailureRecoveryPolicy(");
    expect(handlers).toContain("failSession(");
  });

  it("bounds automatic recreation and restores windows without activation", () => {
    expect(handlers).toContain("rendererRecoveryInFlight.has(surface)");
    expect(handlers).toContain("rendererRecoveryInFlight.add(surface)");
    expect(handlers).toContain('policy.restoreVisibleInactive ? "inactive" : "hidden"');
    expect(main).toContain("else window.showInactive()");
  });

  it.each([
    ["settings", "createSettingsWindow"],
    ["scratchpad", "createScratchpadWindow"],
    ["pill", "createPillWindow"],
  ] as const)("attaches recovery to the %s surface", (surface, factory) => {
    const body = main.slice(main.indexOf(`function ${factory}(`)).slice(0, 2_000);
    expect(body).toContain(`installRendererFailureHandlers(window, "${surface}")`);
  });
});

describe("truthful lifecycle diagnostics", () => {
  const startup = sliceBetween(
    main,
    "startupPromise = app.whenReady().then",
    "void startupPromise.then",
  );
  const startupFailure = main.slice(main.indexOf("}).catch(async (error: unknown) =>"));
  const release = sliceBetween(
    main,
    "function releaseRuntimeResources(",
    "async function finishShutdown(",
  );

  it("creates the recorder before startup gates and records ready last", () => {
    expectPrecedes(startup, "diagnostics = new DiagnosticsRecorder", "runtimePlatformFor(");
    expectPrecedes(startup, "startAccessibilityUpgradeCheck()", 'event: "startup", outcome: "ok"');
  });

  it("records startup rejection before teardown", () => {
    expectPrecedes(startupFailure, 'event: "startup"', "quitting = true");
    expectPrecedes(startupFailure, 'outcome: "failed"', "releaseRuntimeResources()");
  });

  it("drains the final shutdown verdict before exit can run", () => {
    expectPrecedes(release, 'event: "shutdown"', "await diagnostics.flush()");
  });
});

describe("model-install lifecycle", () => {
  const install = sliceBetween(
    main,
    "handle(IPC.systemInstallModel",
    "handle(IPC.systemRemoveModel",
  );

  it("does not claim a phase before the worker observes it", () => {
    const beforeWorker = install.slice(0, install.indexOf("worker.installModel"));
    expect(beforeWorker).not.toContain('phase: "downloading"');
    expect(install).toContain("onProgress: ({ phase, completedBytes, totalBytes })");
    const rendererInstall = sliceBetween(
      styleSettings,
      "const installModel = async (",
      "const removeModel = async (",
    );
    const beforeInvoke = rendererInstall.slice(
      0,
      rendererInstall.indexOf("window.localScribe.system.installModel"),
    );
    expect(beforeInvoke).toContain('progress: { phase: "preparing" }');
    expect(beforeInvoke).toContain("message: `Preparing ${scope.progressTarget}");
    expect(beforeInvoke).not.toContain("message: `Downloading ${scope.progressTarget}");
  });

  it("restores an unrelated warm selection if an install kills its worker", () => {
    expect(install).toContain("const warmSelection = worker.loadedSelection()");
    expect(install).toContain("!workerModelSelectionsMatch(worker.loadedSelection(), warmSelection)");
    expect(install).toContain("await worker.ensureReady(warmSelection)");
  });
});

describe("truthful native dictation menus", () => {
  it("shares the pure busy-state policy across app and tray menus", () => {
    expect(main).toContain("function buildTrayMenu()");
    expect(main).toContain("const dictationItem = dictationMenuPolicy(");
    expect(main).toContain("enabled: dictationItem.enabled");
    expect(main).toContain("click: runDictationMenuAction");
  });
});
