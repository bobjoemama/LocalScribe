import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoldShortcutGesture } from "../src/main/hotkeys/holdShortcutGesture";

describe("HoldShortcutGesture", () => {
  const callbacks = {
    onHoldStart: vi.fn(),
    onHoldEnd: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => vi.useRealTimers());

  it("starts push-to-talk after the grace period and stops on release", () => {
    const gesture = new HoldShortcutGesture(callbacks, 160);
    gesture.keyDown();
    vi.advanceTimersByTime(159);
    expect(callbacks.onHoldStart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callbacks.onHoldStart).toHaveBeenCalledOnce();
    gesture.keyUp();
    expect(callbacks.onHoldEnd).toHaveBeenCalledOnce();
  });

  it("does not start a hold when the key is released quickly", () => {
    const gesture = new HoldShortcutGesture(callbacks, 160);
    gesture.keyDown();
    vi.advanceTimersByTime(60);
    gesture.keyUp();
    vi.runAllTimers();
    expect(callbacks.onHoldStart).not.toHaveBeenCalled();
    expect(callbacks.onHoldEnd).not.toHaveBeenCalled();
  });

  it("cancels a pending hold when another key or mouse input arrives", () => {
    const gesture = new HoldShortcutGesture(callbacks, 160);
    gesture.keyDown();
    vi.advanceTimersByTime(80);
    gesture.modifiedInput();
    vi.runAllTimers();
    gesture.keyUp();
    expect(callbacks.onHoldStart).not.toHaveBeenCalled();
  });

  it("suppresses a hold when Electron delivers an overlapping toggle first", () => {
    const gesture = new HoldShortcutGesture(callbacks, 160);
    expect(gesture.prepareToggle(true)).toBe(true);
    gesture.keyDown();
    vi.runAllTimers();
    gesture.keyUp();
    expect(callbacks.onHoldStart).not.toHaveBeenCalled();
    expect(callbacks.onHoldEnd).not.toHaveBeenCalled();
  });

  it("does not allow toggle dictation during an active hold", () => {
    const gesture = new HoldShortcutGesture(callbacks, 160);
    gesture.keyDown();
    vi.advanceTimersByTime(160);
    expect(gesture.prepareToggle(true)).toBe(false);
    gesture.keyUp();
    expect(callbacks.onHoldStart).toHaveBeenCalledOnce();
    expect(callbacks.onHoldEnd).toHaveBeenCalledOnce();
  });

  it("releases an active hold exactly once when its listener lifecycle resets", () => {
    const gesture = new HoldShortcutGesture(callbacks, 160);
    gesture.keyDown();
    vi.advanceTimersByTime(160);

    gesture.reset();
    gesture.reset();
    gesture.keyUp();

    expect(callbacks.onHoldStart).toHaveBeenCalledOnce();
    expect(callbacks.onHoldEnd).toHaveBeenCalledOnce();
  });
});
