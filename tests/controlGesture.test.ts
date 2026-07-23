import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlGesture } from "../src/main/hotkeys/controlGesture";

describe("ControlGesture", () => {
  const callbacks = {
    onHoldStart: vi.fn(),
    onHoldEnd: vi.fn(),
    onToggle: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => vi.useRealTimers());

  it("starts push-to-talk after the hold grace period and stops on release", () => {
    const gesture = new ControlGesture(callbacks, 160);
    gesture.controlDown();
    vi.advanceTimersByTime(159);
    expect(callbacks.onHoldStart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callbacks.onHoldStart).toHaveBeenCalledOnce();
    gesture.controlUp();
    expect(callbacks.onHoldEnd).toHaveBeenCalledOnce();
  });

  it("turns Control-Space into one toggle without starting a hold", () => {
    const gesture = new ControlGesture(callbacks, 160);
    gesture.controlDown();
    vi.advanceTimersByTime(60);
    gesture.spaceDown();
    vi.advanceTimersByTime(200);
    gesture.controlUp();
    expect(callbacks.onToggle).toHaveBeenCalledOnce();
    expect(callbacks.onHoldStart).not.toHaveBeenCalled();
    expect(callbacks.onHoldEnd).not.toHaveBeenCalled();
  });

  it("does nothing for a quick Control tap", () => {
    const gesture = new ControlGesture(callbacks, 160);
    gesture.controlDown();
    vi.advanceTimersByTime(50);
    gesture.controlUp();
    vi.runAllTimers();
    expect(callbacks.onHoldStart).not.toHaveBeenCalled();
    expect(callbacks.onHoldEnd).not.toHaveBeenCalled();
    expect(callbacks.onToggle).not.toHaveBeenCalled();
  });

  it("keeps a started hold from becoming a toggle", () => {
    const gesture = new ControlGesture(callbacks, 160);
    gesture.controlDown();
    vi.advanceTimersByTime(160);
    gesture.spaceDown();
    gesture.controlUp();
    expect(callbacks.onHoldStart).toHaveBeenCalledOnce();
    expect(callbacks.onHoldEnd).toHaveBeenCalledOnce();
    expect(callbacks.onToggle).not.toHaveBeenCalled();
  });

  it("can let the native global shortcut own the toggle callback", () => {
    const gesture = new ControlGesture(callbacks, 160);
    gesture.controlDown();
    gesture.spaceDown(false);
    vi.runAllTimers();
    gesture.controlUp();
    expect(callbacks.onToggle).not.toHaveBeenCalled();
    expect(callbacks.onHoldStart).not.toHaveBeenCalled();
  });

  it("cancels a pending hold when Control modifies another key or click", () => {
    const gesture = new ControlGesture(callbacks, 160);
    gesture.controlDown();
    vi.advanceTimersByTime(80);
    gesture.modifiedInput();
    vi.runAllTimers();
    gesture.controlUp();
    expect(callbacks.onHoldStart).not.toHaveBeenCalled();
    expect(callbacks.onHoldEnd).not.toHaveBeenCalled();
    expect(callbacks.onToggle).not.toHaveBeenCalled();
  });

  it("routes the native shortcut through the same one-shot gesture", () => {
    const gesture = new ControlGesture(callbacks, 160);
    gesture.controlDown();
    gesture.spaceDown(false);
    gesture.shortcutToggle();
    gesture.shortcutToggle();
    vi.runAllTimers();
    gesture.controlUp();
    expect(callbacks.onToggle).toHaveBeenCalledOnce();
    expect(callbacks.onHoldStart).not.toHaveBeenCalled();
    expect(callbacks.onHoldEnd).not.toHaveBeenCalled();
  });

  it("preserves a native chord delivered before the lower-level Control event", () => {
    const gesture = new ControlGesture(callbacks, 160);
    gesture.shortcutToggle();
    gesture.controlDown();
    vi.runAllTimers();
    gesture.controlUp();
    expect(callbacks.onToggle).toHaveBeenCalledOnce();
    expect(callbacks.onHoldStart).not.toHaveBeenCalled();
    expect(callbacks.onHoldEnd).not.toHaveBeenCalled();
  });

  it("ignores a native toggle after push-to-talk has started", () => {
    const gesture = new ControlGesture(callbacks, 160);
    gesture.controlDown();
    vi.advanceTimersByTime(160);
    gesture.shortcutToggle();
    gesture.controlUp();
    expect(callbacks.onToggle).not.toHaveBeenCalled();
    expect(callbacks.onHoldStart).toHaveBeenCalledOnce();
    expect(callbacks.onHoldEnd).toHaveBeenCalledOnce();
  });
});
