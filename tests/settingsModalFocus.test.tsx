import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { requireIndex, sliceBetween } from "./support/order";

/*
 * The Settings dialog declares `aria-modal="true"`, which asserts that the hub
 * behind the backdrop is unavailable. Nothing enforced that: `aria-modal` does
 * not affect the tab order, no focus was moved into the dialog on open, and
 * none was handed back on close. A keyboard user opened a modal and stayed
 * outside it, then tabbed straight through the backdrop into the hub navigation
 * the dialog had just declared inert.
 *
 * There is no DOM in this suite, so these pin the mechanism in source. The
 * keyboard behaviour itself is listed as not behaviourally verified.
 */
const hub = readFileSync("src/renderer/settings/SettingsApp.tsx", "utf8");
const modal = readFileSync("src/renderer/settings/screens/StyleSettings.tsx", "utf8");

describe("settings dialog keyboard containment", () => {
  it("marks the hub inert for exactly as long as the dialog is open", () => {
    // Every region outside the dialog, and no more than that.
    expect(hub).toContain('<aside className="hub-sidebar" inert={settingsOpen}>');
    // The `inert` is the subject here, not the rest of the attributes: this
    // test broke when the content region stopped being a live region, which is
    // an unrelated property covered in tests/hubAnnouncements.test.tsx.
    expect(hub).toMatch(/<section className="hub-content"[^>]*\binert=\{settingsOpen\}/u);
    // The dialog itself must never be inert, or nothing in it could be used.
    // `requireIndex` rather than `indexOf`: a missing marker returns -1, and
    // `slice(-1)` is one character that trivially satisfies the assertion.
    const render = hub.slice(requireIndex(hub, "{settingsOpen && ("));
    expect(render).toContain("<SettingsModal");
    expect(render).not.toContain("inert");
  });

  it("moves focus into the dialog on open and returns it on close", () => {
    const effect = sliceBetween(
      modal,
      "const opener = document.activeElement;",
      "const attemptDismissal",
    );

    expect(effect).toContain("dialogRef.current?.focus();");
    expect(effect).toContain("return () => {");
    expect(effect).toContain("opener.focus()");
    // Restoring focus to a node the close has already removed throws.
    expect(effect).toContain("opener.isConnected");
  });

  it("gives the dialog a focus target that is not in the tab order", () => {
    const open = modal.lastIndexOf("<section", modal.indexOf('className="ls-settings-modal"'));
    const tag = modal.slice(open, modal.indexOf(">", open) + 1);

    expect(tag).toContain("ref={dialogRef}");
    expect(tag).toContain('role="dialog"');
    expect(tag).toContain('aria-modal="true"');
    // tabIndex={-1} is what makes .focus() work without adding a tab stop.
    expect(tag).toContain("tabIndex={-1}");
  });
});
