import { afterEach, describe, expect, it, vi } from "vitest";
import { createUpdateAdmission, UPDATE_PREPARATION_TIMEOUT_MS } from "../src/main/updates/updateAdmission";
import { registerUpdatePreparation } from "../src/renderer/updatePreparation";
import { rendererSurfaceCanInvoke } from "../src/main/ipcAuthorization";
import { IPC } from "../src/shared/contracts";

function editor(id: number) {
  let unavailable!: () => void;
  const target = { id, prepare: vi.fn(), cancel: vi.fn(),
    onUnavailable: vi.fn((callback: () => void) => { unavailable = callback; return vi.fn(); }) };
  return { ...target, fail: () => unavailable() };
}
const reply = (target: ReturnType<typeof editor>, prepared = true, index = 0) => ({
  requestId: target.prepare.mock.calls[index]![0] as string, prepared,
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("update editor acknowledgement admission", () => {
  it("allows cancellation before retirement but retains the freeze after irreversible retirement", async () => {
    const admission = createUpdateAdmission(), target = editor(1);
    expect(admission.retire()).toBe(false);
    const preparing = admission.prepare([target]);
    expect(admission.retire()).toBe(false);
    admission.acknowledge(1, reply(target)); await preparing;
    const lateFailure = target.onUnavailable.mock.calls[0]![0];
    expect(admission.retire()).toBe(true);
    expect(target.onUnavailable.mock.results[0]!.value).toHaveBeenCalledOnce();
    lateFailure(); admission.cancel();
    admission.acknowledge(1, reply(target, false));
    expect(admission.isPreparing).toBe(true);
    expect(target.cancel).not.toHaveBeenCalled();
    expect(admission.retire()).toBe(false);
  });

  it("requires every captured editor and holds the latch after successful acknowledgement", async () => {
    const admission = createUpdateAdmission();
    const notes = editor(1), settings = editor(2);
    const prepare = admission.prepare([notes, settings]);
    expect(admission.isPreparing).toBe(true);
    admission.acknowledge(1, reply(notes));
    admission.acknowledge(999, reply(settings));
    expect(settings.onUnavailable.mock.results[0]!.value).not.toHaveBeenCalled();
    admission.acknowledge(2, reply(settings)); await prepare;
    expect(admission.isPreparing).toBe(true);
    expect(notes.cancel).not.toHaveBeenCalled();
    admission.cancel();
  });

  it.each(["veto", "crash", "timeout", "send failure"])("releases every freeze after %s", async (failure) => {
    vi.useFakeTimers();
    const admission = createUpdateAdmission();
    const notes = editor(1), settings = editor(2);
    if (failure === "send failure") settings.prepare.mockImplementation(() => { throw new Error("gone"); });
    const prepare = admission.prepare([notes, settings]);
    const rejected = expect(prepare).rejects.toThrow("Save or close pending work");
    if (failure === "veto") admission.acknowledge(1, reply(notes, false));
    if (failure === "crash") settings.fail();
    if (failure === "timeout") await vi.advanceTimersByTimeAsync(UPDATE_PREPARATION_TIMEOUT_MS);
    await rejected;
    expect(admission.isPreparing).toBe(false);
    for (const target of [notes, settings]) {
      expect(target.cancel).toHaveBeenCalledWith(reply(notes).requestId);
      expect(target.onUnavailable.mock.results[0]!.value).toHaveBeenCalledOnce();
    }
  });

  it("ignores malformed/untrusted replies and stale acknowledgements from the prior attempt", async () => {
    const admission = createUpdateAdmission(), notes = editor(1);
    const first = admission.prepare([notes]);
    admission.cancel(); await expect(first).rejects.toThrow();
    const second = admission.prepare([notes]);
    admission.acknowledge(1, reply(notes));
    admission.acknowledge(999, reply(notes, false, 1));
    admission.acknowledge(1, { ...reply(notes, false, 1), extra: "untrusted" });
    expect(admission.isPreparing).toBe(true);
    admission.acknowledge(1, reply(notes, true, 1)); await second;
    admission.cancel();
  });

  it("the Pill cannot acknowledge editor preparation", () => {
    expect(rendererSurfaceCanInvoke("pill", IPC.updatesPrepared)).toBe(false);
    expect(rendererSurfaceCanInvoke("settings", IPC.updatesPrepared)).toBe(true);
    expect(rendererSurfaceCanInvoke("scratchpad", IPC.updatesPrepared)).toBe(true);
  });
});

it("renderer cancellation releases only its own generation and suppresses stale completion", async () => {
  const events = new EventTarget();
  vi.stubGlobal("window", events);
  let prepare!: (requestId: string) => Promise<boolean> | boolean;
  let cancel!: (requestId: string) => void;
  const updates = {
    onPrepareInstall: vi.fn((callback) => { prepare = callback; return vi.fn(); }),
    onInstallCancelled: vi.fn((callback) => { cancel = callback; return vi.fn(); }),
  };
  let complete!: (prepared: boolean) => void;
  const draining = new Promise<boolean>(resolve => { complete = resolve; });
  const freeze = vi.fn();
  const dispose = registerUpdatePreparation({ updates, freeze, prepare: vi.fn()
    .mockReturnValueOnce(draining).mockReturnValueOnce(true) });
  try {
    const first = prepare("first");
    expect(freeze).toHaveBeenLastCalledWith(true);
    const blocked = new Event("keydown", { cancelable: true }); events.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);
    cancel("first"); expect(freeze).toHaveBeenLastCalledWith(false);
    const second = prepare("second"); await expect(second).resolves.toBe(true);
    cancel("first"); complete(true); await expect(first).resolves.toBe(false);
    expect(freeze).toHaveBeenLastCalledWith(true);
    cancel("second"); expect(freeze).toHaveBeenLastCalledWith(false);
  } finally { dispose(); }
  expect(updates.onPrepareInstall.mock.results[0]!.value).toHaveBeenCalledOnce();
  expect(updates.onInstallCancelled.mock.results[0]!.value).toHaveBeenCalledOnce();
});

// Verify an unavailable callback retained by an emitter cannot cancel a later
// generation even if removing the listener raced an event already in dispatch.
it("stale unavailable callbacks leave the next generation admitted", async () => {
  const admission = createUpdateAdmission(), target = editor(9);
  const first = admission.prepare([target]);
  const lateFailure = target.onUnavailable.mock.calls[0]![0];
  admission.cancel(); await expect(first).rejects.toThrow();
  const second = admission.prepare([target]);
  lateFailure();
  admission.acknowledge(9, reply(target, true, 1));
  await expect(second).resolves.toBeUndefined();
  admission.cancel();
});
