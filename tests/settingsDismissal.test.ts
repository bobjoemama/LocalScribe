import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  MODEL_BUSY_MESSAGE,
  SETTINGS_SAVE_BUSY_MESSAGE,
  decideSettingsDismissal,
  type SettingsActivity,
} from "../src/renderer/settings/dismissal";
import { expectPrecedes, requireIndex, sliceBetween } from "./support/order";

/*
 * The dialog could be unmounted in the middle of a model apply or a
 * multi-gigabyte install. Unmounting cancels nothing — main runs the operation
 * under `runExclusiveModelOperation` — it only throws away every `setState`
 * after the `await`, including the failure line that tells the user their
 * previous model is still active. And because the in-flight refs live on the
 * mount, re-opening Settings resets them, so a second Apply can be dispatched
 * and queues behind the first.
 */

const IDLE: SettingsActivity = { modelOperationInFlight: false, settingsSaveInFlight: false };

describe("deciding whether Settings may close", () => {
  it("closes when nothing is in flight", () => {
    expect(decideSettingsDismissal(IDLE)).toEqual({ dismiss: true });
  });

  it("refuses while a model selection is being applied", () => {
    const decision = decideSettingsDismissal({ ...IDLE, modelOperationInFlight: true });

    expect(decision.dismiss).toBe(false);
    expect(decision).toMatchObject({ blockedBy: "model", message: MODEL_BUSY_MESSAGE });
  });

  /*
   * This is the case the old inline guard missed entirely: it only ever read
   * `modelApplyInFlight`, so install, repair, remove, and add — the longest
   * operations in the app — were dismissable throughout.
   */
  it("refuses while a model is being installed, repaired, removed, or added", () => {
    const decision = decideSettingsDismissal({ ...IDLE, modelOperationInFlight: true });

    expect(decision.dismiss).toBe(false);
    expect(decision).toMatchObject({ blockedBy: "model", message: MODEL_BUSY_MESSAGE });
  });

  it("refuses while ordinary settings are being saved", () => {
    const decision = decideSettingsDismissal({ ...IDLE, settingsSaveInFlight: true });

    expect(decision).toMatchObject({ dismiss: false, blockedBy: "save", message: SETTINGS_SAVE_BUSY_MESSAGE });
  });

  it("names the model operation when both are somehow live", () => {
    const decision = decideSettingsDismissal({ modelOperationInFlight: true, settingsSaveInFlight: true });

    expect(decision).toMatchObject({ dismiss: false, blockedBy: "model" });
  });

  it("always explains a refusal instead of refusing silently", () => {
    for (const activity of [
      { ...IDLE, modelOperationInFlight: true },
      { ...IDLE, settingsSaveInFlight: true },
    ]) {
      const decision = decideSettingsDismissal(activity);
      expect(decision.dismiss).toBe(false);
      if (decision.dismiss) continue;
      expect(decision.message.length).toBeGreaterThan(0);
    }
  });

  it("tells the user the wait ends on its own and needs nothing from them", () => {
    // The alternative reading — "this is stuck" — is what makes people
    // force-quit an app in the middle of writing a model to disk.
    for (const message of [MODEL_BUSY_MESSAGE, SETTINGS_SAVE_BUSY_MESSAGE]) {
      expect(message).toMatch(/on its own/u);
      expect(message).toMatch(/stays open/u);
    }
  });

  it("keeps redacted material out of both messages", () => {
    for (const message of [MODEL_BUSY_MESSAGE, SETTINGS_SAVE_BUSY_MESSAGE]) {
      expect(message).not.toMatch(/\/|\\|https?:|\.app\b|~|Users/u);
    }
  });
});

/*
 * The wiring cannot be exercised here: the renderer suite runs in a node
 * environment with no jsdom, so there is no Escape key to press and no tray to
 * click. These pin each call site to the module above; the keyboard and tray
 * behaviour itself is listed as not behaviourally verified.
 */
describe("every path that unmounts the dialog consults the decision", () => {
  const hub = readFileSync("src/renderer/settings/SettingsApp.tsx", "utf8");
  const modal = readFileSync("src/renderer/settings/screens/StyleSettings.tsx", "utf8");

  it("reads the unified model-operation and ordinary-save latches", () => {
    const attempt = sliceBetween(modal, "const attemptDismissal", "const closeSettings");

    expect(attempt).toContain("decideSettingsDismissal(");
    expect(attempt).toContain("modelOperationInFlight: modelOperationInFlight.current");
    expect(attempt).toContain("settingsSaveInFlight: settingsSaveInFlight.current");
  });

  it("surfaces the refusal on both status surfaces so no tab is left silent", () => {
    // The footer suppresses `status` on the model tab; `modelFeedback` renders
    // only on it. Between them every tab is covered.
    const attempt = sliceBetween(modal, "const attemptDismissal", "const closeSettings");

    expect(attempt).toContain("setStatus(decision.message)");
    expect(attempt).toContain("setModelFeedback({ message: decision.message");
    expect(attempt).toContain("return false;");
  });

  it("no longer duplicates the guard inside closeSettings", () => {
    const close = sliceBetween(modal, "const closeSettings", "registerDismissalGate?.(attemptDismissal)");

    expect(close).toContain("attemptDismissal()");
    expect(close).not.toContain("modelOperationInFlight.current");
  });

  it("only closes after the decision allows it", () => {
    const attempt = sliceBetween(modal, "const attemptDismissal", "const closeSettings");

    expectPrecedes(attempt, "if (!decision.dismiss)", "onClose();");
  });

  /*
   * The bypass this whole change exists for. `onNavigate` called
   * `setSettingsOpen(false)` unconditionally, so every tray entry that
   * navigates the hub unmounted the dialog mid-operation.
   */
  it("gates the navigation path that used to close the dialog unconditionally", () => {
    const handler = sliceBetween(hub, "onNavigate((target)", "openSection(target);");

    expect(handler).toContain("dismissalGate.current");
    expectPrecedes(handler, "dismissalGate.current()", "setSettingsOpen(false)");
  });

  it("leaves the hub on its current section when a navigation is refused", () => {
    const handler = sliceBetween(hub, "onNavigate((target)", "openSection(target);");
    const refusal = handler.slice(requireIndex(handler, "dismissalGate.current()"));

    // The early `return` must come before both effects, not just the unmount.
    expectPrecedes(refusal, "return;", "setSettingsOpen(false)");
  });

  it("still opens the dialog on a settings navigation without consulting the gate", () => {
    const handler = sliceBetween(hub, "onNavigate((target)", "openSection(target);");

    expectPrecedes(handler, "setSettingsOpen(true)", "dismissalGate.current");
  });

  it("publishes the gate while the dialog is mounted and clears it on unmount", () => {
    const registration = sliceBetween(modal, "registerDismissalGate?.(attemptDismissal)", "const refresh");

    expect(registration).toContain("registerDismissalGate?.(null)");
    expect(hub).toContain("registerDismissalGate={registerDismissalGate}");
    // A gate rebuilt on every render would re-run the registration effect
    // forever; the hub's setter is memoised with an empty dependency list.
    expect(hub).toContain("const registerDismissalGate = useCallback(");
  });

  it("disables Cancel for library work, not only for the apply", () => {
    const footer = sliceBetween(modal, "ls-settings-footer", "</footer>");
    const cancel = footer.slice(requireIndex(footer, "ls-secondary-button"));

    expect(cancel).toContain("disabled={busy || modelApplying || modelRefreshing || modelAction !== null}");
  });
});
