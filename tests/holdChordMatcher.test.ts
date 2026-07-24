import { describe, expect, it, vi } from "vitest";
import { HoldChordMatcher } from "../src/main/hotkeys/holdChordMatcher";

describe("HoldChordMatcher", () => {
  it("starts only once every required key in a generic chord is held", () => {
    const callbacks = {
      onChordStart: vi.fn(),
      onChordEnd: vi.fn(),
      onModifiedInput: vi.fn(),
    };
    const matcher = new HoldChordMatcher([[29, 3613], [42, 54], [57]], callbacks);

    matcher.keyDown(29); // left Control
    matcher.keyDown(42); // left Shift
    expect(callbacks.onChordStart).not.toHaveBeenCalled();
    matcher.keyDown(57); // Space
    expect(callbacks.onChordStart).toHaveBeenCalledOnce();
    matcher.keyUp(57);
    expect(callbacks.onChordEnd).toHaveBeenCalledOnce();
  });

  it("treats left and right modifier variants as the same logical key", () => {
    const callbacks = {
      onChordStart: vi.fn(),
      onChordEnd: vi.fn(),
      onModifiedInput: vi.fn(),
    };
    const matcher = new HoldChordMatcher([[29, 3613], [56, 3640]], callbacks);

    matcher.keyDown(3613);
    matcher.keyDown(3640);
    expect(callbacks.onChordStart).toHaveBeenCalledOnce();
    matcher.keyUp(3613);
    expect(callbacks.onChordEnd).toHaveBeenCalledOnce();
  });

  it("cancels a partial chord after unrelated input until the hold keys are released", () => {
    const callbacks = {
      onChordStart: vi.fn(),
      onChordEnd: vi.fn(),
      onModifiedInput: vi.fn(),
    };
    const matcher = new HoldChordMatcher([[29, 3613], [57]], callbacks);

    matcher.keyDown(29);
    matcher.keyDown(30); // A while Control is pending
    matcher.keyDown(57);
    expect(callbacks.onModifiedInput).toHaveBeenCalledOnce();
    expect(callbacks.onChordStart).not.toHaveBeenCalled();
    matcher.keyUp(57);
    matcher.keyUp(29);
    matcher.keyDown(29);
    matcher.keyDown(57);
    expect(callbacks.onChordStart).toHaveBeenCalledOnce();
  });

  it("can cancel a pending Windows modifier-only hold when a chord key arrives", () => {
    const callbacks = {
      onChordStart: vi.fn(),
      onChordEnd: vi.fn(),
      onModifiedInput: vi.fn(),
    };
    const matcher = new HoldChordMatcher([[29, 3613]], callbacks, true);

    matcher.keyDown(29);
    expect(callbacks.onChordStart).toHaveBeenCalledOnce();
    matcher.keyDown(57);
    expect(callbacks.onModifiedInput).toHaveBeenCalledOnce();
    matcher.keyUp(57);
    matcher.keyUp(29);

    matcher.keyDown(29);
    expect(callbacks.onChordStart).toHaveBeenCalledTimes(2);
  });

  it("suppresses a matched multi-modifier hold after an extra key until release", () => {
    const callbacks = {
      onChordStart: vi.fn(),
      onChordEnd: vi.fn(),
      onModifiedInput: vi.fn(),
    };
    const matcher = new HoldChordMatcher([[3675, 3676], [29, 3613]], callbacks, true);

    matcher.keyDown(3675); // Command
    matcher.keyDown(29); // Control
    expect(callbacks.onChordStart).toHaveBeenCalledOnce();
    matcher.keyDown(30); // A while Command+Control is pending
    expect(callbacks.onModifiedInput).toHaveBeenCalledOnce();
    matcher.keyUp(30);
    matcher.keyUp(29);
    matcher.keyUp(3675);

    matcher.keyDown(3675);
    matcher.keyDown(29);
    expect(callbacks.onChordStart).toHaveBeenCalledTimes(2);
  });
});
