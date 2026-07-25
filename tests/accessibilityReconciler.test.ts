import { describe, expect, it, vi } from "vitest";
import { reconcileAccessibilityHotkeys } from "../src/main/hotkeys/accessibilityReconciler";

describe("macOS Accessibility hotkey reconciliation", () => {
  it("falls back when access is revoked and contains native teardown failures", () => {
    const failure = new Error("native hook stop failed");
    const hotkeys = {
      start: vi.fn(),
      startFallback: vi.fn(() => {
        throw failure;
      }),
    };
    const warn = vi.fn();

    expect(() => reconcileAccessibilityHotkeys(false, hotkeys, warn)).not.toThrow();
    expect(hotkeys.start).not.toHaveBeenCalled();
    expect(hotkeys.startFallback).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "Global hold-to-talk could not fall back after Accessibility changed",
      failure,
    );
  });

  it("recovers from a failed full hook without leaking a failed fallback", () => {
    const fullFailure = new Error("full hook failed");
    const fallbackFailure = new Error("fallback failed");
    const hotkeys = {
      start: vi.fn(() => {
        throw fullFailure;
      }),
      startFallback: vi.fn(() => {
        throw fallbackFailure;
      }),
    };
    const warn = vi.fn();

    expect(() => reconcileAccessibilityHotkeys(true, hotkeys, warn)).not.toThrow();
    expect(hotkeys.start).toHaveBeenCalledOnce();
    expect(hotkeys.startFallback).toHaveBeenCalledOnce();
    expect(warn.mock.calls).toEqual([
      ["Global hold-to-talk could not start after Accessibility changed", fullFailure],
      ["Global hold-to-talk fallback could not start after Accessibility changed", fallbackFailure],
    ]);
  });

  it("starts the full hook directly when access is granted", () => {
    const hotkeys = { start: vi.fn(), startFallback: vi.fn() };
    reconcileAccessibilityHotkeys(true, hotkeys, vi.fn());
    expect(hotkeys.start).toHaveBeenCalledOnce();
    expect(hotkeys.startFallback).not.toHaveBeenCalled();
  });
});
