import { describe, expect, it } from "vitest";
import { shortcutFromKeyboardEvent } from "../src/renderer/settings/components/ShortcutRecorder";

function keyEvent(code: string, modifiers: Partial<Pick<KeyboardEvent, "ctrlKey" | "altKey" | "metaKey" | "shiftKey">> = {}) {
  return {
    code,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  };
}

describe("shortcut recorder keyboard capture", () => {
  it("uses physical key codes and keeps modifiers in accelerator order", () => {
    expect(shortcutFromKeyboardEvent(keyEvent("Space", { ctrlKey: true, shiftKey: true }))).toBe("Control+Shift+Space");
    expect(shortcutFromKeyboardEvent(keyEvent("KeyK", { metaKey: true }))).toBe("Command+K");
  });

  it("keeps a bare modifier available for hold-to-talk validation", () => {
    expect(shortcutFromKeyboardEvent(keyEvent("ControlLeft", { ctrlKey: true }))).toBe("Control");
    expect(shortcutFromKeyboardEvent(keyEvent("F16"))).toBe("F16");
    expect(shortcutFromKeyboardEvent(keyEvent("Numpad7", { altKey: true }))).toBe("Alt+num7");
  });

  it("preserves Windows AltGr instead of recording its synthesized Control+Alt pair", () => {
    expect(shortcutFromKeyboardEvent({
      ...keyEvent("AltRight", { ctrlKey: true, altKey: true }),
      getModifierState: (modifier) => modifier === "AltGraph",
    })).toBe("AltGr");
    expect(shortcutFromKeyboardEvent({
      ...keyEvent("KeyQ", { ctrlKey: true, altKey: true }),
      getModifierState: (modifier) => modifier === "AltGraph",
    })).toBe("AltGr+Q");
    expect(shortcutFromKeyboardEvent(
      keyEvent("AltRight", { ctrlKey: true, altKey: true }),
    )).toBe("AltGr");
    expect(shortcutFromKeyboardEvent(
      keyEvent("KeyQ", { ctrlKey: true, altKey: true }),
    )).toBe("Control+Alt+Q");
  });
});
