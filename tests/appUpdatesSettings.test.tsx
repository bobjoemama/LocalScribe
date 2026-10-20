import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUpdateState } from "../src/shared/appUpdates";
import { AppUpdatesSettings } from "../src/renderer/settings/screens/AppUpdatesSettings";

// Node-only component logic harness: IPC and hook storage are controlled; the
// production component, callbacks, and subscription helper execute unchanged.
// Browser layout, React scheduling, and native updater integration need the
// existing isolated Settings harness, not this test.
const hooks = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0,
  effects: [] as Array<() => void | (() => void)>,
}));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => {
    const slot = hooks.cursor++;
    if (!(slot in hooks.slots)) hooks.slots[slot] = initial;
    return [hooks.slots[slot], (next: unknown) => {
      hooks.slots[slot] = typeof next === "function" ? next(hooks.slots[slot]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const slot = hooks.cursor++;
    if (!(slot in hooks.slots)) hooks.slots[slot] = { current: initial };
    return hooks.slots[slot];
  },
  useEffect: (effect: () => void | (() => void)) => {
    const slot = hooks.cursor++;
    if (!(slot in hooks.slots)) { hooks.slots[slot] = true; hooks.effects.push(effect); }
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...[element.props.children].flat().flatMap(child => elements(child as ReactNode))];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object" && "props" in node) return text((node as ReactElement<{ children?: ReactNode }>).props.children);
  return "";
}

const current: AppUpdateState = { phase: "current", currentVersion: "0.1.0-dev.24" };
const available: AppUpdateState = { ...current, phase: "available", availableVersion: "0.1.0-dev.25" };
let listener: (state: AppUpdateState) => void;
let initial: ReturnType<typeof deferred<AppUpdateState>>;
let dispose: (() => void) | undefined;
let tree: ReactElement;
let api: { getState: ReturnType<typeof vi.fn>; check: ReturnType<typeof vi.fn>; downloadAndRestart: ReturnType<typeof vi.fn>; onChanged: ReturnType<typeof vi.fn> };
let unsubscribe: ReturnType<typeof vi.fn>;
let confirm: ReturnType<typeof vi.fn>;
const render = () => {
  hooks.cursor = 0;
  tree = AppUpdatesSettings({ checkAutomatically: true, onCheckAutomaticallyChange: vi.fn() });
};
const button = (label: string) => {
  render();
  const result = elements(tree).find(element => element.type === "button" && text(element) === label);
  if (!result) throw new Error(`Missing button ${label}`);
  return result.props as { disabled: boolean; onClick(): void };
};

beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; hooks.effects = [];
  initial = deferred<AppUpdateState>();
  unsubscribe = vi.fn(); confirm = vi.fn(() => true);
  api = {
    getState: vi.fn(() => { expect(listener).toBeTypeOf("function"); return initial.promise; }),
    check: vi.fn(async () => current),
    downloadAndRestart: vi.fn(async () => ({ ...available, phase: "ready" })),
    onChanged: vi.fn((next) => { listener = next; return unsubscribe; }),
  };
  vi.stubGlobal("window", { localScribe: { updates: api }, confirm });
  render();
  dispose = hooks.effects[0]!() ?? undefined;
});
afterEach(() => { dispose?.(); vi.unstubAllGlobals(); });

describe("app update Settings behavior", () => {
  it("keeps a subscribed update over stale initial state and cleans up on unmount", async () => {
    listener(available);
    initial.resolve(current); await initial.promise;
    expect(button("Download and restart").disabled).toBe(false);
    dispose?.(); dispose = undefined;
    listener({ ...current, phase: "unsupported" }); render();
    expect(text(tree)).toContain("An update is available.");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("ignores an initial state that arrives after unmount", async () => {
    dispose?.(); dispose = undefined;
    initial.resolve(available); await initial.promise; render();
    expect(text(tree)).toContain("Loading update status…");
  });

  it("discloses restart and next-quit installation and makes cancellation inert", () => {
    listener(available); confirm.mockReturnValue(false);
    button("Download and restart").onClick();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("next normal quit"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("restart"));
    expect(api.downloadAndRestart).not.toHaveBeenCalled();
    expect(button("Download and restart").disabled).toBe(false);
  });

  it("shows the returned download outcome and allows an explicit restart", async () => {
    listener(available);
    button("Download and restart").onClick();
    await api.downloadAndRestart.mock.results[0]!.value;
    expect(button("Restart to update").disabled).toBe(false);
    expect(text(tree)).toContain("next quits normally");
  });

  it("keeps newer pushed state when an action returns an older snapshot", async () => {
    const action = deferred<AppUpdateState>(); api.check.mockReturnValue(action.promise);
    listener(current); button("Check for updates").onClick();
    listener({ ...available, phase: "ready" });
    action.resolve(current); await action.promise;
    expect(button("Restart to update").disabled).toBe(false);
  });

  it("allows a failed check to be retried and shows native failure recovery", async () => {
    listener(available);
    const failure = deferred<AppUpdateState>(); api.downloadAndRestart.mockReturnValue(failure.promise);
    button("Download and restart").onClick();
    failure.reject(new Error("native failure")); await failure.promise.catch(() => undefined); render();
    expect(text(tree)).toContain("Relaunch LocalScribe before trying again.");
    button("Check for updates").onClick(); await api.check.mock.results[0]!.value; render();
    expect(text(tree)).toContain("LocalScribe is up to date.");
  });

  it("shows backend busy reasons without invented download progress", () => {
    listener({ ...available, phase: "downloading", message: "Finish active dictation before restarting." });
    expect(button("Check for updates").disabled).toBe(true);
    expect(text(tree)).toContain("Finish active dictation before restarting.");
    expect(text(tree)).not.toMatch(/\d+%/);
  });
});
