import { describe, expect, it } from "vitest";
import type { SessionSnapshot } from "../src/shared/contracts";
import { holdShortcutPresentation, isCurrentFinalization } from "../src/renderer/pill/Pill";

const FIRST_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_SESSION_ID = "22222222-2222-4222-8222-222222222222";

describe("pill recorder lifecycle", () => {
  it("accepts finalization work only while the same session is still finalizing", () => {
    const finalizing: SessionSnapshot = {
      state: "finalizing",
      sessionId: FIRST_SESSION_ID,
    };
    expect(isCurrentFinalization(finalizing, FIRST_SESSION_ID)).toBe(true);
    expect(isCurrentFinalization(finalizing, SECOND_SESSION_ID)).toBe(false);

    expect(isCurrentFinalization({
      state: "idle",
    }, FIRST_SESSION_ID)).toBe(false);
    expect(isCurrentFinalization({
      state: "listening",
      sessionId: SECOND_SESSION_ID,
    }, FIRST_SESSION_ID)).toBe(false);
  });
});

describe("pill shortcut presentation", () => {
  it("does not present Control as current until persisted settings are available", () => {
    expect(holdShortcutPresentation(null, "loading")).toEqual({
      tooltip: "Dictate · shortcut settings are loading",
      dictateAriaLabel: "Start dictating; shortcut settings are loading",
    });
    expect(holdShortcutPresentation(null, "unavailable")).toEqual({
      tooltip: "Dictate · shortcut settings are unavailable",
      dictateAriaLabel: "Start dictating; shortcut settings are unavailable",
    });
    const ready = holdShortcutPresentation("Control", "ready");
    expect(ready.tooltip).toMatch(/^Dictate · hold /);
    expect(ready.dictateAriaLabel).toMatch(/^Start dictating; hold /);
  });
});
