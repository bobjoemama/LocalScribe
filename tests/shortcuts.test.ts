import { describe, expect, it } from "vitest";
import {
  canonicalizeShortcut,
  holdShortcutSchema,
  isModifierOnlyShortcut,
  NUMPAD_ENTER_TOGGLE_ERROR,
  parseShortcut,
  shortcutCompactLabel,
  shortcutDisplayLabel,
  shortcutsUseSamePhysicalKeys,
  toggleShortcutSchema,
  toggleUsesHoldKey,
} from "../src/shared/shortcuts";

describe("shortcut helpers", () => {
  it("presents platform-native settings and compact labels", () => {
    expect(shortcutDisplayLabel("Command+Shift+Space")).toBe("Command + Shift + Space");
    expect(shortcutDisplayLabel("CommandOrControl+AltGr+Space"))
      .toBe("Command + AltGr + Space");
    expect(shortcutDisplayLabel("Alt+Space")).toBe("Option + Space");
    expect(shortcutCompactLabel("Control+Space")).toBe("⌃ + Space");
    expect(shortcutCompactLabel("Super+Space")).toBe("⌘ + Space");
  });

  it("detects when a toggle chord overlaps the hold key", () => {
    expect(toggleUsesHoldKey("Control+Space", "Control")).toBe(true);
    expect(toggleUsesHoldKey("F13", "Control")).toBe(false);
  });

  it("canonicalizes Electron-compatible keyboard chords and aliases", () => {
    expect(canonicalizeShortcut(" ctrl + option + f13 ")).toBe("Control+Alt+F13");
    expect(canonicalizeShortcut("cmdorctrl + shift + arrowleft")).toBe("CommandOrControl+Shift+Left");
    expect(canonicalizeShortcut("num7")).toBe("num7");
    expect(canonicalizeShortcut("numpadenter")).toBe("NumpadEnter");
    expect(canonicalizeShortcut("numenter")).toBe("NumpadEnter");
    expect(parseShortcut("Control+Shift")).toMatchObject({ key: null, modifiers: ["Control", "Shift"] });
    expect(isModifierOnlyShortcut("Control+Shift")).toBe(true);
  });

  it("rejects malformed or non-keyboard accelerator strings", () => {
    expect(() => canonicalizeShortcut("Control++A")).toThrow("Use + between shortcut keys.");
    expect(() => canonicalizeShortcut("Control+MediaPlayPause")).toThrow("Unsupported shortcut key");
    expect(() => canonicalizeShortcut("Control+Shift+A+B")).toThrow("only one non-modifier key");
  });

  it("uses platform-neutral validation copy for cross-platform shortcut schemas", () => {
    expect(holdShortcutSchema.safeParse("Control+Shift").success).toBe(true);
    const toggle = toggleShortcutSchema.safeParse("Control+Shift");
    expect(toggle.success).toBe(false);
    if (toggle.success) throw new Error("Expected modifier-only toggle to be rejected");
    expect(toggle.error.issues[0]?.message).toBe(
      "Toggle dictation needs a non-modifier key so the system can register it.",
    );
    expect(toggle.error.issues[0]?.message).not.toMatch(/operating system/i);
  });

  it("keeps Numpad Enter distinct for holds and rejects it as an Electron toggle", () => {
    expect(holdShortcutSchema.parse("NumpadEnter")).toBe("NumpadEnter");
    expect(shortcutDisplayLabel("NumpadEnter")).toBe("Numpad Enter");
    expect(shortcutCompactLabel("NumpadEnter")).toBe("Num Enter");
    expect(shortcutsUseSamePhysicalKeys("NumpadEnter", "Enter")).toBe(false);

    const toggle = toggleShortcutSchema.safeParse("NumpadEnter");
    expect(toggle.success).toBe(false);
    if (toggle.success) throw new Error("Expected Numpad Enter toggle to be rejected");
    expect(toggle.error.issues[0]?.message).toBe(NUMPAD_ENTER_TOGGLE_ERROR);
  });

  it("recognizes an overlap anywhere in a multi-key hold chord", () => {
    expect(toggleUsesHoldKey("Shift+Space", "Control+Shift")).toBe(true);
  });

  it("compares platform-resolved physical key groups rather than accelerator spelling", () => {
    expect(shortcutsUseSamePhysicalKeys("CommandOrControl", "Command")).toBe(true);
    expect(shortcutsUseSamePhysicalKeys("CommandOrControl", "Control")).toBe(false);
    expect(shortcutsUseSamePhysicalKeys("Plus", "Shift+Equal")).toBe(true);
    expect(shortcutsUseSamePhysicalKeys("Alt+F13", "AltGr+F13")).toBe(true);
    expect(toggleUsesHoldKey("AltGr+Space", "Alt")).toBe(true);
    expect(toggleUsesHoldKey("Command+Space", "Control")).toBe(false);
  });
});
