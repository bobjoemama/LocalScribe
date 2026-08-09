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
    NumpadMultiply: 55, NumpadDivide: 3637, NumpadEnter: 3612,
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

import { HotkeyService, uiohookHoldKeyGroups } from "../src/main/hotkeys/hotkeyService";
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
    const service = new HotkeyService(
      vi.fn(), vi.fn(), vi.fn(), null, "Control", "Control+Space",
    );
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
    const service = new HotkeyService(
      vi.fn(), vi.fn(), vi.fn(), null, "Control", "Control+Space",
    );
    expect(service.validateShortcut({ kind: "toggle", shortcut: "ctrl + f13" })).toEqual({
      shortcut: "Control+F13",
      available: true,
    });
    expect(mocks.globalShortcut.register).toHaveBeenCalledWith("Control+F13", expect.any(Function));
    expect(mocks.globalShortcut.unregister).toHaveBeenCalledWith("Control+F13");

    expect(service.validateShortcut({ kind: "hold", shortcut: "Control", otherShortcut: "Control" }))
      .toMatchObject({ available: false, error: expect.stringContaining("different") });
    expect(service.validateShortcut({ kind: "hold", shortcut: "Shift" }))
      .toEqual({ shortcut: "Shift", available: true });
  });

  it("supports distinct Numpad Enter holds but rejects it before Electron toggle registration", () => {
    const onPress = vi.fn();
    const onRelease = vi.fn();
    const service = new HotkeyService(
      onPress,
      onRelease,
      vi.fn(),
      null,
      "NumpadEnter",
      "Control+Space",
      "win32",
    );

    expect(uiohookHoldKeyGroups("NumpadEnter", "win32")).toEqual([[3612]]);
    expect(uiohookHoldKeyGroups("Enter", "win32")).toEqual([[28]]);
    expect(service.validateShortcut({ kind: "hold", shortcut: "NumpadEnter" }))
      .toEqual({ shortcut: "NumpadEnter", available: true });
    expect(mocks.globalShortcut.register).not.toHaveBeenCalled();
    mocks.globalShortcut.register.mockClear();
    expect(service.validateShortcut({ kind: "toggle", shortcut: "NumpadEnter" }))
      .toMatchObject({
        shortcut: "NumpadEnter",
        available: false,
        error: expect.stringContaining("does not support it as a distinct global shortcut"),
      });
    expect(mocks.globalShortcut.register).not.toHaveBeenCalled();

    service.start();
    mocks.listeners.get("keydown")?.({ keycode: 3612 });
    vi.advanceTimersByTime(160);
    expect(onPress).toHaveBeenCalledOnce();
    mocks.listeners.get("keyup")?.({ keycode: 3612 });
    expect(onRelease).toHaveBeenCalledOnce();
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
    const service = new HotkeyService(
      vi.fn(), vi.fn(), vi.fn(), null, "Control", "Control+Space",
    );
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

  /*
   * The test above proves `start()` does not throw, which is the intended
   * behaviour — push-to-talk must survive a toggle another app has taken. What
   * it could not prove is that anyone finds out. The failure was stored in a
   * private field and `console.warn`ed to a stdout that is /dev/null in the
   * packaged app, so main recorded `hotkey/global_register: ok` for a run in
   * which nothing was registered, the tray and app menus went on displaying the
   * accelerator, and Settings went on advising the user to "use the toggle
   * shortcut". Pressing it did nothing and no surface said why.
   */
  it("reports that the toggle is not registered instead of only warning about it", () => {
    const service = new HotkeyService(
      vi.fn(), vi.fn(), vi.fn(), null, "Control", "Control+Space",
    );
    mocks.globalShortcut.register.mockReturnValue(false);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(service.isToggleReady()).toBe(false);
    service.start();

    // `start()` still succeeds, and the hold path still works...
    expect(service.isGlobalHoldReady()).toBe(true);
    // ...but the toggle is knowably dead, which is what nothing could see.
    expect(service.isToggleReady()).toBe(false);
    expect(service.toggleUnavailableReason()).toMatch(/Control\+Space is already used/u);
    warning.mockRestore();
  });

  it("reports a registered toggle as ready", () => {
    const service = new HotkeyService(
      vi.fn(), vi.fn(), vi.fn(), null, "Control", "Control+Space",
    );
    service.start();

    expect(service.isToggleReady()).toBe(true);
    expect(service.toggleUnavailableReason()).toBeNull();
  });

  it("reports the toggle as ready again after a re-save clears the conflict", () => {
    const service = new HotkeyService(
      vi.fn(), vi.fn(), vi.fn(), null, "Control", "Control+Space",
    );
    mocks.globalShortcut.register.mockReturnValue(false);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    service.start();
    expect(service.isToggleReady()).toBe(false);

    // The conflicting app quits and the user re-saves the same shortcut, which
    // is the one path that retries a startup registration failure.
    mocks.globalShortcut.register.mockReturnValue(true);
    service.reconfigure("Control", "Control+Space");

    expect(service.isToggleReady()).toBe(true);
    expect(service.toggleUnavailableReason()).toBeNull();
    warning.mockRestore();
  });

  it("reports the toggle as not ready in the fallback path too", () => {
    const service = new HotkeyService(
      vi.fn(), vi.fn(), vi.fn(), null, "Control", "Control+Space",
    );
    mocks.globalShortcut.register.mockReturnValue(false);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    service.startFallback();

    // Accessibility denied *and* the toggle taken is the total-failure case,
    // and the only prior signal — globalHold.ready — is unrelated to it.
    expect(service.isToggleReady()).toBe(false);
    warning.mockRestore();
  });

  it("removes partially registered hook listeners when listener setup fails", () => {
    const service = new HotkeyService(
      vi.fn(), vi.fn(), vi.fn(), null, "Control", "Control+Space",
    );
    const failure = new Error("listener registration failed");
    mocks.uIOhook.on
      .mockImplementationOnce((event: string, listener: (value: { keycode: number }) => void) => {
        mocks.listeners.set(event, listener);
      })
      .mockImplementationOnce(() => {
        throw failure;
      });

    expect(() => service.start()).toThrow(failure);
    expect(mocks.uIOhook.off).toHaveBeenCalledWith("keydown", expect.any(Function));
    expect(mocks.uIOhook.start).not.toHaveBeenCalled();
    expect(service.isGlobalHoldReady()).toBe(false);
  });

  it("clears service ownership even when native hook teardown throws", () => {
    const onPress = vi.fn();
    const onRelease = vi.fn();
    const service = new HotkeyService(onPress, onRelease, vi.fn(), null, "Control", "Control+Space");
    service.start();
    mocks.listeners.get("keydown")?.({ keycode: 29 });
    vi.advanceTimersByTime(160);
    expect(onPress).toHaveBeenCalledOnce();
    const failure = new Error("native stop failed");
    mocks.uIOhook.stop.mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => service.stop()).toThrow(failure);
    expect(onRelease).toHaveBeenCalledOnce();
    expect(mocks.globalShortcut.unregister).toHaveBeenCalledWith("Control+Space");
    expect(service.isGlobalHoldReady()).toBe(false);
  });

  it("continues to provide the delayed hold gesture through the fallback monitor", () => {
    const onPress = vi.fn();
    const onRelease = vi.fn();
    const monitorState: { listener: ((event: ControlMonitorEvent) => void) | null } = { listener: null };
    const monitor = {
      supports: vi.fn(() => true),
      start: vi.fn((_shortcut: string, nextListener: (event: ControlMonitorEvent) => void) => {
        monitorState.listener = nextListener;
        return true;
      }),
      stop: vi.fn(),
    };
    const service = new HotkeyService(
      onPress,
      onRelease,
      vi.fn(),
      monitor,
      "Control",
      "Control+Space",
      "darwin",
    );

    service.startFallback();
    expect(monitor.start).toHaveBeenCalledOnce();
    expect(service.isGlobalHoldReady()).toBe(true);
    monitorState.listener?.("hold-down");
    vi.advanceTimersByTime(160);
    expect(onPress).toHaveBeenCalledOnce();
    monitorState.listener?.("hold-up");
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it("uses the narrow native monitor as the normal macOS hold path", () => {
    const monitorState: { listener: ((event: ControlMonitorEvent) => void) | null } = {
      listener: null,
    };
    const onPress = vi.fn();
    const onRelease = vi.fn();
    const monitor = {
      supports: vi.fn(() => true),
      start: vi.fn((_shortcut: string, listener: (event: ControlMonitorEvent) => void) => {
        monitorState.listener = listener;
        return true;
      }),
      stop: vi.fn(),
    };
    const service = new HotkeyService(
      onPress,
      onRelease,
      vi.fn(),
      monitor,
      "Command+Control",
      "Control+Space",
      "darwin",
    );

    service.start();

    expect(monitor.start).toHaveBeenCalledWith(
      "Command+Control",
      expect.any(Function),
      expect.any(Function),
    );
    expect(mocks.uIOhook.start).not.toHaveBeenCalled();
    monitorState.listener?.("hold-down");
    vi.advanceTimersByTime(160);
    expect(onPress).toHaveBeenCalledOnce();
    monitorState.listener?.("hold-up");
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it("keeps the Accessibility hook for macOS keys the native monitor cannot identify", () => {
    const monitor = {
      supports: vi.fn(() => false),
      start: vi.fn(() => true),
      stop: vi.fn(),
    };
    const service = new HotkeyService(
      vi.fn(), vi.fn(), vi.fn(), monitor, "F21", "Control+Space", "darwin",
    );

    service.start();

    expect(monitor.start).not.toHaveBeenCalled();
    expect(mocks.uIOhook.start).toHaveBeenCalledOnce();
  });

  it("keeps an active native hold when Accessibility becomes available", () => {
    const onPress = vi.fn();
    const onRelease = vi.fn();
    const monitorState: {
      listener: ((event: ControlMonitorEvent) => void) | null;
    } = { listener: null };
    const monitor = {
      supports: vi.fn(() => true),
      start: vi.fn((_shortcut: string, nextListener: (event: ControlMonitorEvent) => void) => {
        monitorState.listener = nextListener;
        return true;
      }),
      stop: vi.fn(),
    };
    const service = new HotkeyService(
      onPress,
      onRelease,
      vi.fn(),
      monitor,
      "Control",
      "Control+Space",
      "darwin",
    );
    service.startFallback();
    monitorState.listener?.("hold-down");
    vi.advanceTimersByTime(160);
    expect(onPress).toHaveBeenCalledOnce();

    service.start();

    expect(onRelease).not.toHaveBeenCalled();
    expect(monitor.stop).not.toHaveBeenCalled();
    expect(mocks.uIOhook.start).not.toHaveBeenCalled();
    monitorState.listener?.("hold-up");
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it("downgrades after Accessibility revocation and recovers after fallback monitor death", () => {
    const onPress = vi.fn();
    const onRelease = vi.fn();
    let monitorListener: ((event: ControlMonitorEvent) => void) | undefined;
    let onStopped: (() => void) | undefined;
    const monitor = {
      supports: vi.fn(() => true),
      start: vi.fn((
        _shortcut: string,
        nextListener: (event: ControlMonitorEvent) => void,
        nextOnStopped?: () => void,
      ) => {
        monitorListener = nextListener;
        onStopped = nextOnStopped;
        return true;
      }),
      stop: vi.fn(),
    };
    const service = new HotkeyService(
      onPress,
      onRelease,
      vi.fn(),
      monitor,
      "Control",
      "Control+Space",
      "darwin",
    );
    service.start();

    service.startFallback();
    expect(mocks.uIOhook.stop).not.toHaveBeenCalled();
    expect(monitor.start).toHaveBeenCalledOnce();
    expect(service.isGlobalHoldReady()).toBe(true);

    monitorListener?.("hold-down");
    vi.advanceTimersByTime(160);
    expect(onPress).toHaveBeenCalledOnce();
    onStopped?.();
    expect(onRelease).toHaveBeenCalledOnce();
    expect(service.isGlobalHoldReady()).toBe(false);

    service.startFallback();
    expect(monitor.start).toHaveBeenCalledTimes(2);
    expect(service.isGlobalHoldReady()).toBe(true);
  });

  it("reports global hold ready only after a hook or native fallback starts", () => {
    const full = new HotkeyService(
      vi.fn(), vi.fn(), vi.fn(), null, "Control", "Control+Space",
    );
    expect(full.isGlobalHoldReady()).toBe(false);
    full.start();
    expect(full.isGlobalHoldReady()).toBe(true);
    full.stop();
    expect(full.isGlobalHoldReady()).toBe(false);

    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unavailableFallback = new HotkeyService(
      vi.fn(),
      vi.fn(),
      vi.fn(),
      { supports: vi.fn(() => true), start: vi.fn(() => false), stop: vi.fn() },
      "Control",
      "Control+Space",
      "darwin",
    );
    unavailableFallback.startFallback();
    expect(unavailableFallback.isGlobalHoldReady()).toBe(false);
    warning.mockRestore();
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

  it("cancels macOS modifier-only holds when another key or mouse input is used", () => {
    const onPress = vi.fn();
    const service = new HotkeyService(
      onPress,
      vi.fn(),
      vi.fn(),
      null,
      "Command+Control",
      "Control+Space",
      "darwin",
    );
    service.start();

    // Command+Control+A is an application shortcut, not push-to-talk.
    mocks.listeners.get("keydown")?.({ keycode: 3675 });
    mocks.listeners.get("keydown")?.({ keycode: 29 });
    mocks.listeners.get("keydown")?.({ keycode: 30 });
    vi.advanceTimersByTime(160);
    expect(onPress).not.toHaveBeenCalled();
    mocks.listeners.get("keyup")?.({ keycode: 30 });
    mocks.listeners.get("keyup")?.({ keycode: 29 });
    mocks.listeners.get("keyup")?.({ keycode: 3675 });

    // Clicking while the modifier hold is pending also cancels it.
    mocks.listeners.get("keydown")?.({ keycode: 3675 });
    mocks.listeners.get("keydown")?.({ keycode: 29 });
    mocks.listeners.get("mousedown")?.({ keycode: 1 });
    vi.advanceTimersByTime(160);
    expect(onPress).not.toHaveBeenCalled();
    mocks.listeners.get("keyup")?.({ keycode: 29 });
    mocks.listeners.get("keyup")?.({ keycode: 3675 });

    // A clean Command+Control hold still starts dictation.
    mocks.listeners.get("keydown")?.({ keycode: 3675 });
    mocks.listeners.get("keydown")?.({ keycode: 29 });
    vi.advanceTimersByTime(160);
    expect(onPress).toHaveBeenCalledOnce();
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
      .toEqual({ shortcut: "Shift", available: true });

    mocks.uIOhook.start.mockImplementationOnce(() => {
      throw new Error("Windows hook unavailable");
    });
    expect(() => service.start()).toThrow("Windows hook unavailable");
    expect(() => service.startFallback()).not.toThrow();
    expect(service.validateShortcut({ kind: "hold", shortcut: "Shift" }))
      .toMatchObject({ available: false, error: expect.stringContaining("hook did not start") });
    expect(() => service.reconfigure("Shift", "Control+Space"))
      .toThrow("push-to-talk cannot be changed");
    expect(() => service.reconfigure("Control", "F13")).not.toThrow();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("Windows global keyboard hook could not start"),
    );
    warning.mockRestore();
  });

  it("uses macOS physical aliases and supports arbitrary native modifier holds", () => {
    const monitor = {
      supports: vi.fn(() => true),
      start: vi.fn(() => true),
      stop: vi.fn(),
    };
    const service = new HotkeyService(
      vi.fn(),
      vi.fn(),
      vi.fn(),
      monitor,
      "CommandOrControl",
      "Control+Space",
      "darwin",
    );

    expect(service.validateShortcut({
      kind: "hold",
      shortcut: "CommandOrControl",
      otherShortcut: "Command",
    })).toMatchObject({ available: false, error: expect.stringContaining("different") });
    expect(service.validateShortcut({
      kind: "hold",
      shortcut: "Command+Control",
      otherShortcut: "Control",
    })).toEqual({ shortcut: "Command+Control", available: true });

    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    service.startFallback();
    expect(monitor.start).toHaveBeenCalledWith(
      "CommandOrControl",
      expect.any(Function),
      expect.any(Function),
    );
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });
});
