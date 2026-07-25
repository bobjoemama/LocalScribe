import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ShortcutRecorder,
  shortcutRecorderErrorMessage,
  shortcutFromKeyboardEvent,
} from "../src/renderer/settings/components/ShortcutRecorder";

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
  it("does not expose local paths from shortcut capture failures", () => {
    expect(shortcutRecorderErrorMessage(
      new Error("EPERM at C:\\Users\\Alice\\private\\helper.exe"),
      "Shortcut recording could not start. Try again.",
    )).toBe("Shortcut recording could not start. Try again.");
  });

  it("waits for trusted runtime platform information before enabling capture", () => {
    const pending = renderToStaticMarkup(createElement(ShortcutRecorder, {
      kind: "toggle",
      label: "Toggle dictation shortcut",
      detail: "Press once to start and stop.",
      value: "CommandOrControl+Space",
      platform: null,
      onAccept: async () => ({ accepted: true }),
    }));
    expect(pending).toContain("shortcut platform information is loading");
    expect(pending).toContain("disabled");
    expect(pending).toContain("CommandOrControl+Space");

    const windows = renderToStaticMarkup(createElement(ShortcutRecorder, {
      kind: "toggle",
      label: "Toggle dictation shortcut",
      detail: "Press once to start and stop.",
      value: "CommandOrControl+Space",
      platform: "win32",
      onAccept: async () => ({ accepted: true }),
    }));
    expect(windows).not.toContain("disabled");
    expect(windows).toContain("Control + Space");
  });

  it("uses physical key codes and keeps modifiers in accelerator order", () => {
    expect(shortcutFromKeyboardEvent(keyEvent("Space", { ctrlKey: true, shiftKey: true }))).toBe("Control+Shift+Space");
    expect(shortcutFromKeyboardEvent(keyEvent("KeyK", { metaKey: true }), "darwin")).toBe("Command+K");
    expect(shortcutFromKeyboardEvent(keyEvent("KeyK", { metaKey: true }), "win32")).toBe("Super+K");
    expect(shortcutFromKeyboardEvent(keyEvent("MetaLeft", { metaKey: true }), "darwin")).toBe("Command");
    expect(shortcutFromKeyboardEvent(keyEvent("MetaLeft", { metaKey: true }), "win32")).toBe("Super");
  });

  it("keeps a bare modifier available for hold-to-talk validation", () => {
    expect(shortcutFromKeyboardEvent(keyEvent("ControlLeft", { ctrlKey: true }))).toBe("Control");
    expect(shortcutFromKeyboardEvent(keyEvent("F16"))).toBe("F16");
    expect(shortcutFromKeyboardEvent(keyEvent("Numpad7", { altKey: true }))).toBe("Alt+num7");
    expect(shortcutFromKeyboardEvent(keyEvent("NumpadEnter"), "win32")).toBe("NumpadEnter");
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
