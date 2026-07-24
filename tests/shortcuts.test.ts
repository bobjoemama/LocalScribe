import { describe, expect, it } from "vitest";
import {
  canonicalizeShortcut,
  isModifierOnlyShortcut,
  parseShortcut,
  shortcutCompactLabel,
  shortcutDisplayLabel,
  shortcutsUseSamePhysicalKeys,
  toggleUsesHoldKey,
} from "../src/shared/shortcuts";

describe("shortcut helpers", () => {
  it("presents platform-native settings and compact labels", () => {
    expect(shortcutDisplayLabel("Command+Shift+Space", "darwin")).toBe("Command + Shift + Space");
    expect(shortcutCompactLabel("Control+Space", "darwin")).toBe("⌃ + Space");
    expect(shortcutDisplayLabel("Command+Shift+Space", "win32")).toBe("Windows + Shift + Space");
    expect(shortcutCompactLabel("Control+Space", "win32")).toBe("Ctrl + Space");
    expect(shortcutDisplayLabel("Alt+Space", "linux")).toBe("Alt + Space");
  });

  it("detects when a toggle chord overlaps the hold key", () => {
    expect(toggleUsesHoldKey("Control+Space", "Control")).toBe(true);
    expect(toggleUsesHoldKey("F13", "Control")).toBe(false);
  });

  it("canonicalizes Electron-compatible keyboard chords and aliases", () => {
    expect(canonicalizeShortcut(" ctrl + option + f13 ")).toBe("Control+Alt+F13");
    expect(canonicalizeShortcut("cmdorctrl + shift + arrowleft")).toBe("CommandOrControl+Shift+Left");
    expect(canonicalizeShortcut("num7")).toBe("num7");
    expect(parseShortcut("Control+Shift")).toMatchObject({ key: null, modifiers: ["Control", "Shift"] });
    expect(isModifierOnlyShortcut("Control+Shift")).toBe(true);
  });

  it("rejects malformed or non-keyboard accelerator strings", () => {
    expect(() => canonicalizeShortcut("Control++A")).toThrow("Use + between shortcut keys.");
    expect(() => canonicalizeShortcut("Control+MediaPlayPause")).toThrow("Unsupported shortcut key");
    expect(() => canonicalizeShortcut("Control+Shift+A+B")).toThrow("only one non-modifier key");
  });

  it("recognizes an overlap anywhere in a multi-key hold chord", () => {
    expect(toggleUsesHoldKey("Shift+Space", "Control+Shift")).toBe(true);
  });

  it("compares platform-resolved physical key groups rather than accelerator spelling", () => {
    expect(shortcutsUseSamePhysicalKeys("CommandOrControl", "Command", "darwin")).toBe(true);
    expect(shortcutsUseSamePhysicalKeys("CommandOrControl", "Control", "win32")).toBe(true);
    expect(shortcutsUseSamePhysicalKeys("Plus", "Shift+Equal", "darwin")).toBe(true);
    expect(toggleUsesHoldKey("AltGr+Space", "Alt", "win32")).toBe(true);
    expect(toggleUsesHoldKey("Command+Space", "Control", "darwin")).toBe(false);
  });
});
