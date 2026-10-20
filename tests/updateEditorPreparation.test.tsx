import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScratchpadWindow } from "../src/renderer/scratchpad/ScratchpadWindow";
import { createUpdateAdmission } from "../src/main/updates/updateAdmission";
import { registerUpdatePreparation } from "../src/renderer/updatePreparation";
import { decideSettingsDismissal } from "../src/renderer/settings/dismissal";
import type { ScratchpadNote } from "../src/shared/contracts";

// Production component/hooks logic, real debounce/save/drain and real admission.
// React scheduling, DOM layout and transport are separate integration checks.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0,
  effects: [] as Array<() => void | (() => void)> }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => {
    const slot = hooks.cursor++;
    if (!(slot in hooks.slots)) hooks.slots[slot] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[slot], (next: unknown) => {
      hooks.slots[slot] = typeof next === "function" ? next(hooks.slots[slot]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const slot = hooks.cursor++;
    if (!(slot in hooks.slots)) hooks.slots[slot] = { current: initial };
    return hooks.slots[slot];
  },
  useCallback: (callback: unknown) => callback,
  useMemo: (calculate: () => unknown) => calculate(),
  useEffect: (effect: () => void | (() => void)) => {
    const slot = hooks.cursor++;
    if (!(slot in hooks.slots)) { hooks.slots[slot] = true; hooks.effects.push(effect); }
  },
}));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props.children as ReactNode)];
}
function transport() {
  const admission = createUpdateAdmission();
  let prepare!: (requestId: string) => boolean | Promise<boolean>;
  let cancel!: (requestId: string) => void;
  const updates = {
    onPrepareInstall: (listener: typeof prepare) => { prepare = listener; return () => undefined; },
    onInstallCancelled: (listener: typeof cancel) => { cancel = listener; return () => undefined; },
  };
  const participant = { id: 10,
    prepare: (requestId: string) => {
      void Promise.resolve(prepare(requestId)).then(prepared => admission.acknowledge(10, { requestId, prepared }));
    },
    cancel: (requestId: string) => cancel(requestId),
    onUnavailable: () => () => undefined,
  };
  return { admission, updates, begin: () => admission.prepare([participant]) };
}
const note: ScratchpadNote = { id: "cbb9fdbe-dc5b-4003-b493-c423d44f3c3e", title: "Draft", body: "Saved", createdAt: 1, updatedAt: 1 };
const disposals: Array<() => void> = [];
beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; hooks.effects = [];
  vi.useFakeTimers();
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
});
afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) dispose();
  vi.useRealTimers(); vi.unstubAllGlobals();
});
async function notesWindow() {
  const connection = transport();
  disposals.push(connection.admission.cancel);
  const listed = deferred<{ items: ScratchpadNote[]; totalStored: number; skippedUnreadable: number }>();
  const writes: Array<ReturnType<typeof deferred<ScratchpadNote>>> = [];
  const secondWriteStarted = deferred<void>();
  let durableBody = note.body;
  const update = vi.fn((_id: string, _body: string) => {
    const pending = deferred<ScratchpadNote>(); writes.push(pending);
    if (writes.length === 2) secondWriteStarted.resolve();
    return pending.promise.then(saved => { durableBody = saved.body; return saved; });
  });
  const api = { updates: connection.updates, scratchpad: { list: () => listed.promise, update }, windows: {} };
  vi.stubGlobal("window", Object.assign(new EventTarget(), { localScribe: api,
    setTimeout, clearTimeout, confirm: vi.fn(() => true) }));
  const root = { inert: false };
  const render = () => {
    hooks.cursor = 0;
    const tree = ScratchpadWindow();
    (tree.props.ref as { current: unknown }).current = root;
    return tree;
  };
  render();
  for (const effect of hooks.effects) { const cleanup = effect(); if (cleanup) disposals.push(cleanup); }
  listed.resolve({ items: [note], totalStored: 1, skippedUnreadable: 0 }); await listed.promise;
  const textarea = () => {
    const control = elements(render()).find(element => element.type === "textarea");
    if (!control) throw new Error("Missing Notes editor");
    return control.props as { value: string; onChange(event: { target: { value: string } }): void };
  };
  return { ...connection, root, writes, update, textarea, secondWriteStarted: secondWriteStarted.promise, durableBody: () => durableBody };
}

describe("actual Notes save drain before update acknowledgement", () => {
  it("flushes the 350ms pending draft and waits for its durable acknowledgement while editing is frozen", async () => {
    const notes = await notesWindow();
    notes.textarea().onChange({ target: { value: "Typed during download" } });
    expect(notes.update).not.toHaveBeenCalled();
    const preparing = notes.begin();
    expect(notes.root.inert).toBe(true);
    expect(notes.update).toHaveBeenCalledWith(note.id, "Typed during download");
    notes.textarea().onChange({ target: { value: "Must be blocked" } });
    expect(notes.textarea().value).toBe("Typed during download");
    notes.writes[0]!.resolve({ ...note, body: "Typed during download" });
    await preparing;
    expect(notes.durableBody()).toBe("Typed during download");
    expect(notes.root.inert).toBe(true);
    expect(notes.admission.isPreparing).toBe(true);
  });

  it("vetoes a failed Notes write, releases the freeze, and retains the unsaved body for retry", async () => {
    const notes = await notesWindow();
    notes.textarea().onChange({ target: { value: "Keep this unsaved draft" } });
    const preparing = notes.begin();
    const veto = expect(preparing).rejects.toThrow("Save or close pending work");
    notes.writes[0]!.reject(new Error("write failed")); await veto;
    expect(notes.durableBody()).toBe("Saved");
    expect(notes.textarea().value).toBe("Keep this unsaved draft");
    expect(notes.root.inert).toBe(false);
    const retry = notes.begin();
    notes.writes[1]!.resolve({ ...note, body: "Keep this unsaved draft" }); await retry;
    expect(notes.durableBody()).toBe("Keep this unsaved draft");
  });

  it("includes an older in-flight write as well as the newer pending draft in the drain", async () => {
    const notes = await notesWindow();
    notes.textarea().onChange({ target: { value: "First body" } });
    vi.advanceTimersByTime(350);
    notes.textarea().onChange({ target: { value: "Latest body" } });
    const preparing = notes.begin();
    expect(notes.writes).toHaveLength(1);
    notes.writes[0]!.resolve({ ...note, body: "First body" });
    await notes.secondWriteStarted;
    notes.writes[1]!.resolve({ ...note, body: "Latest body" }); await preparing;
    expect(notes.durableBody()).toBe("Latest body");
  });

  it("persists a revert to the saved body after an older write is already in flight", async () => {
    const notes = await notesWindow();
    notes.textarea().onChange({ target: { value: "First body" } });
    vi.advanceTimersByTime(350);
    notes.textarea().onChange({ target: { value: "Saved" } });
    const preparing = notes.begin();
    notes.writes[0]!.resolve({ ...note, body: "First body" });
    await notes.secondWriteStarted;
    expect(notes.update).toHaveBeenLastCalledWith(note.id, "Saved");
    notes.writes[1]!.resolve(note); await preparing;
    expect(notes.durableBody()).toBe("Saved");
  });
});

// Execute the dialog's actual live gate. Only the confirmation UI is doubled;
// draft references, busy decision and coordinator are real production logic.
function settingsGate() {
  const file = ts.createSourceFile("StyleSettings.tsx", readFileSync("src/renderer/settings/screens/StyleSettings.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let gate: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "attemptDismissal" && node.initializer
      && ts.isCallExpression(node.initializer)) gate = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(file); if (!gate) throw new Error("Missing live Settings dismissal gate");
  const state = { decideSettingsDismissal, modelOperationInFlight: { current: false }, settingsSaveInFlight: { current: false },
    dirtySettings: { current: {} as Record<string, unknown> }, pendingModelSelectionRef: { current: null as unknown },
    window: { confirm: vi.fn(() => false) }, setStatus: vi.fn(), setModelFeedback: vi.fn(),
    setPendingModelSelection: vi.fn(), presentation: "modal", onClose: vi.fn() };
  const context = vm.createContext(state);
  vm.runInContext(ts.transpileModule(`var gate = ${gate.getText(file)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return context as typeof state & { gate(forUpdate?: boolean): boolean };
}

function shellPreparation(gate: ((forUpdate?: boolean) => boolean) | null) {
  const file = ts.createSourceFile("SettingsApp.tsx", readFileSync("src/renderer/settings/SettingsApp.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let prepare: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "registerUpdatePreparation") {
      const argument = node.arguments[0];
      if (argument && ts.isObjectLiteralExpression(argument)) {
        for (const property of argument.properties) {
          if (ts.isPropertyAssignment(property) && property.name.getText(file) === "prepare") prepare = property.initializer;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file); if (!prepare) throw new Error("Missing Settings shell preparation");
  const state = { dismissalGate: { current: gate }, modelPageGate: { current: null as typeof gate },
    shellRef: { current: { querySelector: vi.fn((): unknown => null) } }, setUpdateNotice: vi.fn() };
  const context = vm.createContext(state);
  vm.runInContext(ts.transpileModule(`var prepare = ${prepare.getText(file)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return context as typeof state & { prepare(): boolean };
}

describe("Settings admission checks current drafts at restart time", () => {
  it("prompts for a draft created during download, preserves it on cancel, and never unmounts on update preparation", async () => {
    vi.stubGlobal("window", new EventTarget());
    const settings = settingsGate(), connection = transport();
    const shell = shellPreparation(settings.gate);
    const freeze = vi.fn();
    disposals.push(connection.admission.cancel);
    disposals.push(registerUpdatePreparation({ updates: connection.updates, freeze, prepare: shell.prepare }));
    // Download was approved when clean; this edit arrived before ready/install.
    settings.dirtySettings.current = { appearance: "dark" };
    await expect(connection.begin()).rejects.toThrow("Save or close pending work");
    expect(settings.window.confirm).toHaveBeenCalledWith("Discard your unsaved settings changes?");
    expect(settings.dirtySettings.current).toEqual({ appearance: "dark" });
    expect(freeze).toHaveBeenLastCalledWith(false);
    settings.window.confirm.mockReturnValue(true);
    await connection.begin();
    expect(settings.onClose).not.toHaveBeenCalled();
    expect(settings.setPendingModelSelection).not.toHaveBeenCalled();
    expect(freeze).toHaveBeenLastCalledWith(true);
  });

  it("acknowledges a clean shell with no Settings modal mounted", () => {
    const shell = shellPreparation(null);
    expect(shell.prepare()).toBe(true);
  });

  it("preserves independent Dictionary, Snippets and app profile editors and explains how to retry", () => {
    const settings = settingsGate(), shell = shellPreparation(settings.gate);
    shell.shellRef.current.querySelector.mockReturnValue({});
    expect(shell.prepare()).toBe(false);
    expect(shell.setUpdateNotice).toHaveBeenCalledWith(expect.stringContaining("Save or close the open Dictionary, Snippets, or app profile editor"));
    expect(settings.onClose).not.toHaveBeenCalled();
    expect(settings.window.confirm).not.toHaveBeenCalled();
  });

  it("consults the live Models page gate independently of the Settings modal", () => {
    const settings = settingsGate(), shell = shellPreparation(null);
    shell.modelPageGate.current = settings.gate;
    settings.pendingModelSelectionRef.current = { familyId: "draft" };
    expect(shell.prepare()).toBe(false);
    expect(settings.window.confirm).toHaveBeenCalledOnce();
  });

  it.each(["settingsSaveInFlight", "modelOperationInFlight"] as const)("vetoes %s without discarding the view", (kind) => {
    const settings = settingsGate(); settings[kind].current = true;
    expect(settings.gate(true)).toBe(false);
    expect(settings.window.confirm).not.toHaveBeenCalled();
    expect(settings.onClose).not.toHaveBeenCalled();
  });

  it("also protects a pending model selection without ordinary settings edits", () => {
    const settings = settingsGate(); settings.pendingModelSelectionRef.current = { familyId: "new-family" };
    expect(settings.gate(true)).toBe(false);
    expect(settings.window.confirm).toHaveBeenCalledOnce();
    expect(settings.pendingModelSelectionRef.current).toEqual({ familyId: "new-family" });
  });
});
