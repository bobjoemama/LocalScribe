import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createUpdateAdmission, type UpdateEditor } from "../src/main/updates/updateAdmission";
import { createMacUpdates } from "../src/main/updates/macUpdates";

// Production main functions run without booting Electron/models/user storage.
// The admission protocol is real; only OS cleanup and native IPC are doubled.
const main = ts.createSourceFile("main.ts", readFileSync("src/main.ts", "utf8"), ts.ScriptTarget.Latest, true);
const names = ["appUpdateIsIdle", "prepareAppUpdateInstall", "beginListening", "canSwitchModelNow"];
const source = main.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""))
  .map((node) => node.getText(main)).join("\n");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  let finish!: () => void;
  const cleanup = new Promise<void>((resolve) => { finish = resolve; });
  let observeCleanup!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => { observeCleanup = resolve; });
  const updateAdmission = createUpdateAdmission();
  const editor = { id: 7, prepare: vi.fn(), cancel: vi.fn(), onUnavailable: () => () => undefined };
  const state = {
    updateRetirementStarted: false, updateAdmission, updateEditors: (): UpdateEditor[] => [editor],
    quitting: false, databaseInitialized: true, resettingSavedData: false,
    runtimeReleaseFailed: false, modelBusy: false, session: { state: "idle" },
    startupPromise: Promise.resolve(),
    modelOperationInProgress: () => state.modelBusy,
    beginShutdown: vi.fn(() => { state.quitting = true; return true; }),
    releaseRuntimeResources: vi.fn(() => { observeCleanup(); return cleanup; }),
    dialog: { showMessageBox: vi.fn(async () => ({})) },
    app: { exit: vi.fn() },
  };
  const context = vm.createContext(state);
  vm.runInContext(compiled, context);
  const functions = context as typeof state & {
    appUpdateIsIdle(): boolean; prepareAppUpdateInstall(): Promise<void>;
    beginListening(): { state: string }; canSwitchModelNow(): boolean;
  };
  const acknowledge = (prepared = true) => updateAdmission.acknowledge(editor.id, {
    requestId: editor.prepare.mock.calls[0]![0], prepared,
  });
  return { state: functions, finish, acknowledge, cleanupStarted };
}

describe("production Mac update shutdown admission", () => {
  it.each(["idle", "success", "error", "listening", "finalizing", "transcribing", "inserting"])(
    "admits model changes only in the literal idle state: %s", (phase) => {
      const { state } = harness(); state.session.state = phase;
      expect(state.canSwitchModelNow()).toBe(phase === "idle");
    });

  it("keeps surviving editors frozen if another renderer fails after retirement starts", async () => {
    const { state, finish, cleanupStarted } = harness();
    let crashSettings!: () => void;
    let notesFrozen = false;
    const settings = { id: 20, prepare: vi.fn(), cancel: vi.fn(),
      onUnavailable: (callback: () => void) => { crashSettings = callback; return () => undefined; } };
    const notes = { id: 21, prepare: vi.fn(() => { notesFrozen = true; }),
      cancel: vi.fn(() => { notesFrozen = false; }), onUnavailable: () => () => undefined };
    state.updateEditors = () => [settings, notes];
    const preparing = state.prepareAppUpdateInstall();
    const requestId = settings.prepare.mock.calls[0]![0];
    state.updateAdmission.acknowledge(20, { requestId, prepared: true });
    state.updateAdmission.acknowledge(21, { requestId, prepared: true });
    await cleanupStarted;
    try {
      expect(state.quitting).toBe(true);
      crashSettings();
      expect(notesFrozen).toBe(true);
      expect(notes.cancel).not.toHaveBeenCalled();
      expect(state.updateAdmission.isPreparing).toBe(true);
    } finally { finish(); await preparing; }
  });

  it("keeps the database and persistence live until editors acknowledge their saves", async () => {
    const { state, finish, acknowledge } = harness();
    const preparing = state.prepareAppUpdateInstall();
    expect(state.beginShutdown).not.toHaveBeenCalled();
    expect(state.releaseRuntimeResources).not.toHaveBeenCalled();
    expect(state.quitting).toBe(false);
    expect(state.updateAdmission.isPreparing).toBe(true);
    acknowledge(); finish(); await preparing;
    expect(state.beginShutdown).toHaveBeenCalledOnce();
  });

  it.each(["listening", "finalizing", "transcribing", "inserting"])("refuses restart during %s", async (phase) => {
    const { state } = harness(); state.session.state = phase;
    await expect(state.prepareAppUpdateInstall()).rejects.toThrow("busy");
    expect(state.beginShutdown).not.toHaveBeenCalled();
    expect(state.releaseRuntimeResources).not.toHaveBeenCalled();
  });

  it("latches before editor acknowledgement, rejects shortcuts/models and a second install", async () => {
    const { state, finish, acknowledge } = harness();
    const preparing = state.prepareAppUpdateInstall();
    expect(state.quitting).toBe(false);
    expect(state.beginListening()).toBe(state.session);
    expect(state.canSwitchModelNow()).toBe(false);
    expect(state.appUpdateIsIdle()).toBe(false);
    await expect(state.prepareAppUpdateInstall()).rejects.toThrow("busy");
    acknowledge(); finish(); await preparing;
    expect(state.quitting).toBe(true);
    expect(state.updateRetirementStarted).toBe(true);
    expect(state.beginShutdown).toHaveBeenCalledOnce();
    expect(state.releaseRuntimeResources).toHaveBeenCalledOnce();
    expect(state.app.exit).not.toHaveBeenCalled();
  });

  it("keeps drafts and live resources after an editor veto", async () => {
    const { state, acknowledge } = harness();
    const preparing = state.prepareAppUpdateInstall();
    acknowledge(false);
    await expect(preparing).rejects.toThrow("Save or close pending work");
    expect(state.beginShutdown).not.toHaveBeenCalled();
    expect(state.releaseRuntimeResources).not.toHaveBeenCalled();
    expect(state.appUpdateIsIdle()).toBe(true);
    expect(state.canSwitchModelNow()).toBe(true);
  });

  it.each(["modelBusy", "resettingSavedData"] as const)("does not retire resources during %s", async (key) => {
    const { state } = harness(); state[key] = true;
    await expect(state.prepareAppUpdateInstall()).rejects.toThrow("busy");
    expect(state.beginShutdown).not.toHaveBeenCalled();
  });

  it("reports failed cleanup and ends the retired app instead of continuing with a closed database", async () => {
    const { state, finish, acknowledge } = harness(); state.runtimeReleaseFailed = true;
    const preparing = state.prepareAppUpdateInstall(); acknowledge(); finish();
    await expect(preparing).rejects.toThrow("Runtime cleanup failed");
    expect(state.dialog.showMessageBox).toHaveBeenCalledOnce();
    expect(state.app.exit).toHaveBeenCalledWith(1);
  });
});

function mainCallback(expression: string, firstArgument: string): string {
  let result: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(main) === expression
      && node.arguments[0]?.getText(main) === firstArgument) result = node.arguments[1];
    ts.forEachChild(node, visit);
  };
  visit(main);
  if (!result) throw new Error(`Missing production ${expression} callback`);
  return ts.transpileModule(`var callback = ${result.getText(main)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
function updateSubscriber(): string {
  let result: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(main) === "updates.subscribe") result = node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(main);
  if (!result) throw new Error("Missing main update subscriber");
  return ts.transpileModule(`var onUpdate = ${result.getText(main)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

it("ordinary quit cancels metadata failure without a fatal install error or early process exit", async () => {
  let rejectFetch!: (error: Error) => void;
  let fetchStarted!: () => void;
  const started = new Promise<void>(resolve => { fetchStarted = resolve; });
  const request = new Promise<Response>((_resolve, reject) => { rejectFetch = reject; });
  const updater = Object.assign(new EventEmitter(), {
    setFeedURL: vi.fn(), checkForUpdates: vi.fn(), quitAndInstall: vi.fn(),
  });
  const updates = createMacUpdates({ currentVersion: "0.1.0-dev.24", platform: "darwin", arch: "arm64",
    isPackaged: true, updater, fetch: vi.fn(() => { fetchStarted(); return request; }),
    isIdle: () => true, prepareInstall: async () => undefined });
  const state = {
    updates, quitting: false, updateRetirementStarted: false, updateFailureShown: false,
    updateAdmission: createUpdateAdmission(), settingsWindow: null, IPC: { updatesChanged: "updates:changed" },
    sendToLiveRenderers: vi.fn(), dialog: { showMessageBox: vi.fn(async () => ({})) },
    app: { exit: vi.fn() }, beginShutdown: vi.fn(() => { state.quitting = true; }),
    finishShutdown: vi.fn(async () => undefined), console,
  };
  const context = vm.createContext(state);
  vm.runInContext(updateSubscriber() + "\n" + mainCallback("app.on", '"before-quit"'), context);
  const callbacks = context as typeof state & { onUpdate(state: unknown): void; callback(event: { preventDefault(): void }): void };
  updates.subscribe(callbacks.onUpdate);
  const checking = updates.check(); await started;
  callbacks.callback({ preventDefault: vi.fn() });
  rejectFetch(new Error("metadata unavailable")); await checking;
  // Exercise even a late queued error notification at the production listener.
  callbacks.onUpdate({ phase: "error" });
  expect(state.beginShutdown).toHaveBeenCalledOnce();
  expect(state.finishShutdown).toHaveBeenCalledOnce();
  expect(state.dialog.showMessageBox).not.toHaveBeenCalled();
  expect(state.app.exit).not.toHaveBeenCalled();
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
});


it("update admission prevents creating or showing a new editor generation", async () => {
  const names = ["showScratchpad", "showHub", "createSettingsWindow", "createScratchpadWindow", "showWhenReady"];
  const source = main.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""))
    .map(node => node.getText(main)).join("\n");
  const admission = createUpdateAdmission();
  await admission.prepare([]);
  const state = { quitting: false, updateAdmission: admission, BrowserWindow: vi.fn() };
  const context = vm.createContext(state);
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const windows = context as typeof state & { showHub(): void; showScratchpad(): void; createSettingsWindow(): void; createScratchpadWindow(): void };
  try {
    windows.showHub(); windows.showScratchpad();
    expect(() => windows.createSettingsWindow()).toThrow("preparing to restart");
    expect(() => windows.createScratchpadWindow()).toThrow("preparing to restart");
    expect(state.BrowserWindow).not.toHaveBeenCalled();
  } finally { admission.cancel(); }
});
