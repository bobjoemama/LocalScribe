import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SettingsApp } from "../src/renderer/settings/SettingsApp";

/*
 * A live region announces everything inside it, every time any of it changes.
 *
 * The hub content region wrapped all six screens, which made it announce the
 * wrong thing at the wrong size: typing one character into the history search
 * re-read the entire filtered list, and clicking a sidebar item spoke a whole
 * screen. HistoryInsights already blanks its own polite paragraph when its
 * role="alert" card is showing, precisely so one change is not announced twice
 * — evidence that the container region was already fighting the screens.
 *
 * The fix is not "announce less": it is that announcements belong to the
 * elements that know what changed.
 */
describe("what the settings hub announces", () => {
  const html = renderToStaticMarkup(createElement(SettingsApp));

  it("does not turn the whole content region into a live region", () => {
    const region = html.slice(html.indexOf('class="hub-content"'));

    // The attribute would sit inside the opening tag of the section.
    expect(region.slice(0, region.indexOf(">"))).not.toContain("aria-live");
  });

  it("has no live region wrapping more than one screen", () => {
    /*
     * The general form of the defect, so re-adding it to any ancestor is
     * caught: nothing that contains the screen switch may be a live region.
     */
    const containers = html.match(/<(?:main|section|div)[^>]*aria-live[^>]*>/gu) ?? [];

    expect(containers).toEqual([]);
  });

  it("still exposes the destination and dialog relationships", () => {
    // Unchanged by the above: removing an announcement must not remove the
    // structure a screen reader navigates by.
    expect(html.match(/aria-current="page"/gu)).toHaveLength(1);
    expect(html).toContain('aria-haspopup="dialog"');
  });
});
