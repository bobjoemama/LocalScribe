import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsModal, ModelsScreen } from "../src/renderer/settings/screens/StyleSettings";
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
    const html = renderToStaticMarkup(createElement(SettingsModal, { onClose: () => undefined }));
    const open = html.indexOf('<section class="ls-settings-modal"');
    expect(open).toBeGreaterThanOrEqual(0);
    const tag = html.slice(open, html.indexOf(">", open) + 1);
    expect(tag).toContain('role="dialog"');
    expect(tag).toContain('aria-modal="true"');
    expect(tag).toContain('tabindex="-1"');
    const dialogTag = modal.slice(modal.indexOf("ref={dialogRef}"), modal.indexOf("tabIndex={-1}") + "tabIndex={-1}".length);
    expect(dialogTag).toContain("presentation === \"page\"");
    const models = renderToStaticMarkup(createElement(ModelsScreen));
    expect(models).not.toContain('role="dialog"');
    expect(models).not.toContain('aria-modal="true"');
  });

  it("exposes the active settings destination semantically", () => {
    expect(modal).toContain('aria-current={tab === item.id ? "page" : undefined}');
  });
});


describe("settings dialog Tab wrapping", () => {
  it("wraps forward and reverse focus within enabled visible dialog controls", () => {
    const handler = sliceBetween(modal, "const closeOnEscape", "window.addEventListener(\"keydown\", closeOnEscape)");
    expect(handler).toContain('event.key === "Tab"');
    expect(handler).toContain("control.getClientRects().length > 0");
    expect(handler).toContain("event.shiftKey");
    expect(handler).toContain("event.preventDefault(); last?.focus()");
    expect(handler).toContain("event.preventDefault(); first?.focus()");
  });
});
