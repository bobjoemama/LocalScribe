import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalScribeApi } from "../src/shared/contracts";
import { IPC } from "../src/shared/contracts";

const electron = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener },
}));
let events: EventEmitter;
let api: LocalScribeApi;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  events = new EventEmitter();
  electron.on.mockImplementation((...args: [string, (...args: unknown[]) => void]) => events.on(...args));
  electron.removeListener.mockImplementation((...args: [string, (...args: unknown[]) => void]) => events.removeListener(...args));
  electron.invoke.mockResolvedValue(undefined);
  await import("../src/preload");
  api = electron.expose.mock.calls[0]![1] as LocalScribeApi;
});
afterEach(() => events.removeAllListeners());
const requestId = "1b18ea0e-c395-4f23-8ea9-f5c2c7461177";

function nextInvocation() {
  let invoked!: (args: unknown[]) => void;
  const promise = new Promise<unknown[]>(resolve => { invoked = resolve; });
  electron.invoke.mockImplementationOnce((...args: unknown[]) => { invoked(args); return Promise.resolve(); });
  return promise;
}

describe("preload update preparation protocol", () => {
  it("freezes the editor in the event turn and acknowledges only after its asynchronous drain completes", async () => {
    let complete!: (prepared: boolean) => void;
    const draining = new Promise<boolean>(resolve => { complete = resolve; });
    const editor = vi.fn(() => draining);
    const unsubscribe = api.updates.onPrepareInstall(editor);
    events.emit(IPC.updatesPrepareInstall, {}, { requestId });
    expect(editor).toHaveBeenCalledWith(requestId);
    expect(electron.invoke).not.toHaveBeenCalled();
    const invoked = nextInvocation(); complete(true);
    await expect(invoked).resolves.toEqual([IPC.updatesPrepared, { requestId, prepared: true }]);
    unsubscribe(); expect(events.listenerCount(IPC.updatesPrepareInstall)).toBe(0);
  });

  it.each(["throw", "reject"])("sends a negative acknowledgement when the editor callback fails by %s", async (failure) => {
    api.updates.onPrepareInstall(() => {
      if (failure === "throw") throw new Error("save failed");
      return Promise.reject(new Error("save failed"));
    });
    const invoked = nextInvocation();
    events.emit(IPC.updatesPrepareInstall, {}, { requestId });
    await expect(invoked).resolves.toEqual([IPC.updatesPrepared, { requestId, prepared: false }]);
  });

  it("validates strict request/cancellation payloads and unsubscribes both channels", () => {
    const prepare = vi.fn(() => true), cancel = vi.fn();
    const offPrepare = api.updates.onPrepareInstall(prepare), offCancel = api.updates.onInstallCancelled(cancel);
    for (const invalid of [{ requestId: "not-a-uuid" }, { requestId, prepared: true }, null]) {
      events.emit(IPC.updatesPrepareInstall, {}, invalid);
      events.emit(IPC.updatesInstallCancelled, {}, invalid);
    }
    expect(prepare).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
    events.emit(IPC.updatesInstallCancelled, {}, { requestId });
    expect(cancel).toHaveBeenCalledWith(requestId);
    offPrepare(); offCancel();
    expect(events.listenerCount(IPC.updatesPrepareInstall)).toBe(0);
    expect(events.listenerCount(IPC.updatesInstallCancelled)).toBe(0);
  });
});
