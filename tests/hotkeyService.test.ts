import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (event: { keycode: number }) => void>();
  return {
    listeners,
    globalShortcut: {
      register: vi.fn((_shortcut: string, _callback: () => void) => true),
      unregister: vi.fn((_shortcut: string) => undefined),
      setSuspended: vi.fn(),
      isSuspended: vi.fn(() => false),
    },
    uIOhook: {
      on: vi.fn((event: string, listener: (value: { keycode: number }) => void) => {
        listeners.set(event, listener);
      }),
      off: vi.fn((event: string) => listeners.delete(event)),
      start: vi.fn(),
      stop: vi.fn(),
    },
  };
});

vi.mock("electron", () => ({ globalShortcut: mocks.globalShortcut }));
vi.mock("uiohook-napi", () => ({
  uIOhook: mocks.uIOhook,
  UiohookKey: {
    Ctrl: 29, CtrlRight: 3613, Alt: 56, AltRight: 3640, Shift: 42, ShiftRight: 54,
    Meta: 3675, MetaRight: 3676, Space: 57, Tab: 15, Backspace: 14, Delete: 3667,
    Insert: 3666, Enter: 28, Escape: 1, ArrowUp: 57416, ArrowDown: 57424,
    ArrowLeft: 57419, ArrowRight: 57421, Home: 3655, End: 3663, PageUp: 3657,
    PageDown: 3665, Equal: 13, NumpadDecimal: 83, NumpadAdd: 78, NumpadSubtract: 74,
    NumpadMultiply: 55, NumpadDivide: 3637,
    A: 30, B: 48, C: 46, D: 32, E: 18, F: 33, G: 34, H: 35, I: 23, J: 36,
    K: 37, L: 38, M: 50, N: 49, O: 24, P: 16, Q: 17, R: 19, S: 31, T: 20,
    U: 22, V: 47, W: 17, X: 45, Y: 21, Z: 44,
    0: 11, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10,
    F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67,
    F10: 68, F11: 87, F12: 88, F13: 91, F14: 92, F15: 93, F16: 99, F17: 100,
    F18: 101, F19: 102, F20: 103, F21: 104, F22: 105, F23: 106, F24: 107,
    Numpad0: 82, Numpad1: 79, Numpad2: 80, Numpad3: 4, Numpad4: 75, Numpad5: 76,
    Numpad6: 77, Numpad7: 71, Numpad8: 72, Numpad9: 73,
  },
}));

import { HotkeyService } from "../src/main/hotkeys/hotkeyService";
import type { ControlMonitorEvent } from "../src/main/hotkeys/macControlMonitor";

describe("HotkeyService capture and validation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.globalShortcut.register.mockReturnValue(true);
    mocks.globalShortcut.isSuspended.mockReturnValue(false);
  });

  afterEach(() => vi.useRealTimers());

  it("suppresses uiohook and Electron shortcuts during capture, then recovers on timeout", () => {
    const onPress = vi.fn();
    const service = new HotkeyService(onPress, vi.fn(), vi.fn(), null, "Control", "Control+Space");
    service.start();
    service.beginCapture();
    expect(mocks.globalShortcut.setSuspended).toHaveBeenCalledWith(true);
    mocks.listeners.get("keydown")?.({ keycode: 29 });
    vi.advanceTimersByTime(200);
    expect(onPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20_000);
    expect(mocks.globalShortcut.setSuspended).toHaveBeenLastCalledWith(false);
  });

  it("releases capture state when Electron cannot suspend or resume shortcuts", () => {
    const service = new HotkeyService(vi.fn(), vi.fn(), vi.fn());
    const failure = new Error("native suspension failed");
    mocks.globalShortcut.setSuspended.mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => service.beginCapture()).toThrow(failure);
    expect(mocks.globalShortcut.setSuspended).toHaveBeenNthCalledWith(1, true);
    expect(mocks.globalShortcut.setSuspended).toHaveBeenNthCalledWith(2, false);
    expect(service.validateShortcut({ kind: "toggle", shortcut: "F13" })).toMatchObject({ available: true });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.globalShortcut.setSuspended.mockImplementationOnce(() => undefined).mockImplementationOnce(() => {
      throw failure;
    });
    service.beginCapture();
    expect(() => service.endCapture()).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith(
      "Could not resume shortcuts after recording a shortcut",
      failure,
    );

    // Capture is no longer stuck, so a subsequent attempt can suspend again.
    expect(() => service.beginCapture()).not.toThrow();
    service.endCapture();
    consoleError.mockRestore();
  });

  it("probes a non-modifier chord temporarily and reports conflicts structurally", () => {
    const service = new HotkeyService(vi.fn(), vi.fn(), vi.fn());
    expect(service.validateShortcut({ kind: "toggle", shortcut: "ctrl + f13" })).toEqual({
      shortcut: "Control+F13",
      available: true,
    });
    expect(mocks.globalShortcut.register).toHaveBeenCalledWith("Control+F13", expect.any(Function));
    expect(mocks.globalShortcut.unregister).toHaveBeenCalledWith("Control+F13");

    expect(service.validateShortcut({ kind: "hold", shortcut: "Control", otherShortcut: "Control" }))
      .toMatchObject({ available: false, error: expect.stringContaining("different") });
    expect(service.validateShortcut({ kind: "hold", shortcut: "Shift" }))
      .toMatchObject({ available: true, warning: expect.stringContaining("cannot be fully checked") });
  });

  it("keeps the live shortcut config intact when the OS preflight rejects a new toggle", () => {
    const service = new HotkeyService(vi.fn(), vi.fn(), vi.fn(), null, "Control", "Control+Space");
    service.start();
    mocks.globalShortcut.register.mockReturnValueOnce(false);

    expect(() => service.reconfigure("Alt", "F13")).toThrow("Toggle dictation is unavailable");
    expect(mocks.uIOhook.stop).not.toHaveBeenCalled();
    expect(mocks.globalShortcut.unregister).not.toHaveBeenCalledWith("Control+Space");
    expect(service.validateShortcut({ kind: "toggle", shortcut: "Control+Space" }))
      .toEqual({ shortcut: "Control+Space", available: true });
  });

  it("keeps an unchanged live toggle registered while only the hold shortcut changes", () => {
    const service = new HotkeyService(vi.fn(), vi.fn(), vi.fn(), null, "Control", "Control+Space");
    service.start();
    mocks.globalShortcut.register.mockClear();
    mocks.globalShortcut.unregister.mockClear();

    service.reconfigure("Alt", "Control+Space");

    expect(mocks.globalShortcut.register).not.toHaveBeenCalled();
    expect(mocks.globalShortcut.unregister).not.toHaveBeenCalled();
    expect(mocks.uIOhook.stop).toHaveBeenCalledOnce();
    expect(mocks.uIOhook.start).toHaveBeenCalledTimes(2);
  });

  it("restores the live shortcuts when final registration loses a race after preflight", () => {
    const service = new HotkeyService(vi.fn(), vi.fn(), vi.fn(), null, "Control", "Control+Space");
    service.start();
    mocks.globalShortcut.register.mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValueOnce(true);

    expect(() => service.reconfigure("Alt", "F13")).toThrow("Toggle dictation is unavailable");
    expect(mocks.globalShortcut.register.mock.calls.map((args) => args[0] as string)).toEqual([
      "Control+Space",
      "F13",
      "F13",
      "Control+Space",
    ]);
    expect(service.validateShortcut({ kind: "toggle", shortcut: "Control+Space" }))
      .toEqual({ shortcut: "Control+Space", available: true });
  });

  it("keeps dictation running when a persisted toggle becomes unavailable and does not retry it in fallback", () => {
    const service = new HotkeyService(vi.fn(), vi.fn(), vi.fn());
    mocks.globalShortcut.register.mockReturnValue(false);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() => service.start()).not.toThrow();
    expect(mocks.uIOhook.start).toHaveBeenCalledOnce();
    expect(mocks.globalShortcut.register).toHaveBeenCalledTimes(1);

    service.stop();
    mocks.uIOhook.start.mockImplementationOnce(() => {
      throw new Error("Accessibility unavailable");
    });
    expect(() => service.start()).toThrow("Accessibility unavailable");
    expect(() => service.startFallback()).not.toThrow();
    // The startup attempt happened once; fallback uses the hold monitor without
    // repeatedly attempting the same known-conflicting accelerator.
    expect(mocks.globalShortcut.register).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });

  it("continues to provide the delayed hold gesture through the fallback monitor", () => {
    const onPress = vi.fn();
    const onRelease = vi.fn();
    const monitorState: { listener: ((event: ControlMonitorEvent) => void) | null } = { listener: null };
    const monitor = {
      start: vi.fn((nextListener: (event: ControlMonitorEvent) => void) => {
        monitorState.listener = nextListener;
        return true;
      }),
      stop: vi.fn(),
    };
    const service = new HotkeyService(onPress, onRelease, vi.fn(), monitor);

    service.startFallback();
    expect(monitor.start).toHaveBeenCalledOnce();
    monitorState.listener?.("control-down");
    vi.advanceTimersByTime(160);
    expect(onPress).toHaveBeenCalledOnce();
    monitorState.listener?.("control-up");
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it("keeps Windows Ctrl+Space toggle distinct from a Control push-to-talk hold", () => {
    const onPress = vi.fn();
    const onRelease = vi.fn();
    const onToggle = vi.fn();
    const service = new HotkeyService(
      onPress,
      onRelease,
      onToggle,
      null,
      "Control",
      "Control+Space",
      "win32",
    );
    service.start();
    const toggleRegistration = mocks.globalShortcut.register.mock.calls.find(
      ([shortcut]) => shortcut === "Control+Space",
    );
    const toggleCallback = toggleRegistration?.[1] as (() => void) | undefined;
    expect(toggleCallback).toBeTypeOf("function");

    mocks.listeners.get("keydown")?.({ keycode: 29 });
    mocks.listeners.get("keydown")?.({ keycode: 57 });
    toggleCallback?.();
    vi.advanceTimersByTime(200);
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onPress).not.toHaveBeenCalled();
    mocks.listeners.get("keyup")?.({ keycode: 57 });
    mocks.listeners.get("keyup")?.({ keycode: 29 });

    vi.advanceTimersByTime(600);
    mocks.listeners.get("keydown")?.({ keycode: 29 });
    vi.advanceTimersByTime(160);
    expect(onPress).toHaveBeenCalledOnce();
    mocks.listeners.get("keyup")?.({ keycode: 29 });
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it("uses Windows-specific shortcut diagnostics and preserves toggle fallback", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = new HotkeyService(
      vi.fn(),
      vi.fn(),
      vi.fn(),
      null,
      "Control",
      "Control+Space",
      "win32",
    );

    expect(service.validateShortcut({ kind: "toggle", shortcut: "Control" }))
      .toMatchObject({ available: false, error: expect.stringContaining("Windows") });
    expect(service.validateShortcut({ kind: "hold", shortcut: "Shift" }))
      .toMatchObject({ available: true, warning: expect.stringContaining("Windows") });

    mocks.uIOhook.start.mockImplementationOnce(() => {
      throw new Error("Windows hook unavailable");
    });
    expect(() => service.start()).toThrow("Windows hook unavailable");
    expect(() => service.startFallback()).not.toThrow();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("Windows global keyboard hook could not start"),
    );
    warning.mockRestore();
  });
});
