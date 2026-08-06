import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ShortcutRecorder,
  shortcutRecorderErrorMessage,
  shortcutFromKeyboardEvent,
  shouldRestoreRecorderFocus,
} from "../src/renderer/settings/components/ShortcutRecorder";
import { expectPrecedes, sliceBetween } from "./support/order";

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

/*
 * Committing a shortcut sets `validating`, which disables the button the user
 * just activated. Disabling the focused element blurs it and focus lands on
 * `document.body`, so a keyboard user was dropped out of the dialog with
 * nothing focused. There is no DOM in this suite, so this pins the mechanism in
 * source; the behaviour itself is listed as not behaviourally verified.
 */
describe("shortcut recorder keyboard focus", () => {
  const source = readFileSync("src/renderer/settings/components/ShortcutRecorder.tsx", "utf8");

  /*
   * These two used to slice the source starting AT `const orphaned =` and then
   * assert that the slice contained "orphaned" — matching the very text used to
   * locate it. Both assertions were constants. An audit confirmed the decisive
   * mutant: inverting the guard to `&& !orphaned`, which produces exactly the
   * regression the test is named for, passed lint, typecheck, and both tests.
   *
   * The decision is now a pure exported function that takes the two elements as
   * arguments, so the whole truth table is exercised for real.
   */
  const button = { name: "recorder button" };
  const body = { name: "document.body" };
  const elsewhere = { name: "some other control" };

  it("restores focus when a finished validation left nothing focused", () => {
    expect(shouldRestoreRecorderFocus({
      wasValidating: true,
      validating: false,
      activeElement: body,
      body,
    })).toBe(true);

    // Some browsers report null rather than the body.
    expect(shouldRestoreRecorderFocus({
      wasValidating: true,
      validating: false,
      activeElement: null,
      body,
    })).toBe(true);
  });

  it("never steals focus that something else has taken", () => {
    // The inverted-guard mutant returns true here, and that is the whole point:
    // moving focus a user deliberately placed is worse than losing it.
    expect(shouldRestoreRecorderFocus({
      wasValidating: true,
      validating: false,
      activeElement: elsewhere,
      body,
    })).toBe(false);

    expect(shouldRestoreRecorderFocus({
      wasValidating: true,
      validating: false,
      activeElement: button,
      body,
    })).toBe(false);
  });

  it("does nothing on an ordinary re-render or while validation is still running", () => {
    expect(shouldRestoreRecorderFocus({
      wasValidating: false,
      validating: false,
      activeElement: body,
      body,
    })).toBe(false);

    expect(shouldRestoreRecorderFocus({
      wasValidating: false,
      validating: true,
      activeElement: body,
      body,
    })).toBe(false);

    // Still validating: the button is still disabled, so focusing it is a no-op
    // at best and fights the user at worst.
    expect(shouldRestoreRecorderFocus({
      wasValidating: true,
      validating: true,
      activeElement: body,
      body,
    })).toBe(false);
  });

  it("is the decision the component actually uses", () => {
    // One structural assertion, kept narrow: it pins the wiring, while the
    // behaviour above is covered by execution.
    expect(source).toContain("const buttonRef = useRef<HTMLButtonElement>(null);");
    expect(source).toContain("ref={buttonRef}");
    const effect = sliceBetween(
      source,
      "shouldRestoreRecorderFocus({",
      "}, [validating]);",
      "ShortcutRecorder.tsx",
    );
    expectPrecedes(effect, "activeElement: document.activeElement", "buttonRef.current?.focus()");
  });
});
