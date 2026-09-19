import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Exercise the real main-process callbacks without starting Electron. In the
// shutdown race the window still exists, but SQLite has already been closed.
const source = ts.createSourceFile("main.ts", readFileSync("src/main.ts", "utf8"), ts.ScriptTarget.Latest, true);
const functionNames = ["showWhenReady", "createPillWindow", "syncPillVisibility", "resizePill"];
const functions = source.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && functionNames.includes(node.name?.text ?? ""));
const executable = ts.transpileModule(functions.map((node) => node.getText(source)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

class FakeWindow extends EventEmitter {
  destroyed = false;
  isDestroyed = () => this.destroyed;
  show = vi.fn();
  showInactive = vi.fn();
  hide = vi.fn();
  getSize = vi.fn(() => [100, 40]);
  setSize = vi.fn();
  setHasShadow = vi.fn();
  setAlwaysOnTop = vi.fn();
  setVisibleOnAllWorkspaces = vi.fn();
  setHiddenInMissionControl = vi.fn();
  loadURL = vi.fn(async () => undefined);
}

function harness() {
  let databaseClosed = false;
  const settings = { showPillWhenIdle: true, asrMode: "after-stop" };
  const getSettings = vi.fn(() => {
    if (databaseClosed) throw new Error("The database connection is not open");
    return settings;
  });
  const positionPill = vi.fn();
  const pillSizeFor = vi.fn(() => ({ width: 200, height: 60 }));
  const context = {
    quitting: false,
    pillWindow: null as FakeWindow | null,
    session: { state: "idle", activation: "toggle" },
    pillMode: "collapsed",
    database: { getSettings },
    positionPill,
    pillSizeFor,
    BrowserWindow: FakeWindow,
    PILL_LAYOUT: { idle: { collapsed: { width: 100, height: 40 } } },
    commonWebPreferences: () => ({}),
    hardenWindow: vi.fn(),
    installRendererFailureHandlers: vi.fn(),
    rendererUrl: () => "http://fixture/pill",
  };
  const api = vm.runInNewContext(`${executable}\n({ ${functionNames.join(", ")} });`, context) as {
    showWhenReady: (window: FakeWindow, visibility: "active" | "inactive" | "hidden") => void;
    createPillWindow: () => FakeWindow;
    syncPillVisibility: () => void;
    resizePill: () => void;
  };
  const window = api.createPillWindow();
  context.pillWindow = window;
  return {
    ...api, window, context, settings, getSettings, positionPill, pillSizeFor,
    beginShutdown() { context.quitting = true; databaseClosed = true; },
  };
}

function expectNoWindowChanges(fixture: ReturnType<typeof harness>) {
  expect(fixture.window.show).not.toHaveBeenCalled();
  expect(fixture.window.showInactive).not.toHaveBeenCalled();
  expect(fixture.window.hide).not.toHaveBeenCalled();
  expect(fixture.window.setSize).not.toHaveBeenCalled();
  expect(fixture.positionPill).not.toHaveBeenCalled();
}

describe("renderer callbacks during shutdown", () => {
  it("ignores a pill ready-to-show event delivered after the database closes", () => {
    const fixture = harness();
    fixture.beginShutdown();

    expect(() => fixture.window.emit("ready-to-show")).not.toThrow();
    expect(fixture.getSettings).not.toHaveBeenCalled();
    expectNoWindowChanges(fixture);
  });

  it.each(["idle", "listening"])("does not synchronize or resize the %s pill while quitting", (state) => {
    const fixture = harness();
    fixture.context.session.state = state;
    fixture.beginShutdown();

    expect(() => fixture.syncPillVisibility()).not.toThrow();
    expect(() => fixture.resizePill()).not.toThrow();
    expect(fixture.getSettings).not.toHaveBeenCalled();
    expect(fixture.pillSizeFor).not.toHaveBeenCalled();
    expectNoWindowChanges(fixture);
  });

  it.each(["active", "inactive"] as const)("does not show an %s recovery window when readiness arrives during quit", (visibility) => {
    const fixture = harness();
    const recoveryWindow = new FakeWindow();
    fixture.showWhenReady(recoveryWindow, visibility);
    fixture.beginShutdown();
    recoveryWindow.emit("ready-to-show");

    expect(recoveryWindow.show).not.toHaveBeenCalled();
    expect(recoveryWindow.showInactive).not.toHaveBeenCalled();
  });

  it.each([true, false])("honors idle pill visibility before shutdown: %s", (showPillWhenIdle) => {
    const fixture = harness();
    fixture.settings.showPillWhenIdle = showPillWhenIdle;
    fixture.window.emit("ready-to-show");

    expect(fixture.getSettings).toHaveBeenCalledOnce();
    expect(fixture.window.showInactive).toHaveBeenCalledTimes(showPillWhenIdle ? 1 : 0);
    expect(fixture.window.hide).toHaveBeenCalledTimes(showPillWhenIdle ? 0 : 1);
    expect(fixture.positionPill).toHaveBeenCalledTimes(showPillWhenIdle ? 1 : 0);
  });

  it("shows an active session and resizes using live settings before shutdown", () => {
    const fixture = harness();
    fixture.context.session.state = "listening";
    fixture.settings.showPillWhenIdle = false;
    fixture.syncPillVisibility();
    fixture.resizePill();

    expect(fixture.window.showInactive).toHaveBeenCalledOnce();
    expect(fixture.window.hide).not.toHaveBeenCalled();
    expect(fixture.pillSizeFor).toHaveBeenCalledExactlyOnceWith("listening", "collapsed", "toggle", "after-stop");
    expect(fixture.window.setSize).toHaveBeenCalledExactlyOnceWith(200, 60, false);
    expect(fixture.positionPill).toHaveBeenCalledTimes(2);
  });

  it.each(["active", "inactive", "hidden"] as const)("preserves %s recovery visibility before shutdown", (visibility) => {
    const fixture = harness();
    const recoveryWindow = new FakeWindow();
    fixture.showWhenReady(recoveryWindow, visibility);
    recoveryWindow.emit("ready-to-show");

    expect(recoveryWindow.show).toHaveBeenCalledTimes(visibility === "active" ? 1 : 0);
    expect(recoveryWindow.showInactive).toHaveBeenCalledTimes(visibility === "inactive" ? 1 : 0);
  });

  it.each(["destroyed", "null"])("ignores a %s pill before shutdown", (state) => {
    const fixture = harness();
    if (state === "destroyed") fixture.window.destroyed = true;
    else fixture.context.pillWindow = null;
    fixture.window.emit("ready-to-show");
    fixture.syncPillVisibility();
    fixture.resizePill();

    expect(fixture.getSettings).not.toHaveBeenCalled();
    expectNoWindowChanges(fixture);
  });

  it("does not show a recovery window destroyed before it becomes ready", () => {
    const fixture = harness();
    const recoveryWindow = new FakeWindow();
    fixture.showWhenReady(recoveryWindow, "active");
    recoveryWindow.destroyed = true;
    recoveryWindow.emit("ready-to-show");

    expect(recoveryWindow.show).not.toHaveBeenCalled();
    expect(recoveryWindow.showInactive).not.toHaveBeenCalled();
  });
});
