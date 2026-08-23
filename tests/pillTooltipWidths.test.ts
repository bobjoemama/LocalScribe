import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PILL_LAYOUT } from "../src/shared/pillLayout";
import { sliceFollowing } from "./support/order";

/*
 * The idle pill's tooltip is a fixed box with 10px of padding, so it can only
 * show `PILL_LAYOUT.idle.hover.width - 29` of text. Every string longer than
 * that is truncated, and the box declared `text-overflow: ellipsis` to say so —
 * but it also declared `display: grid`, which puts the text in an anonymous grid
 * item. `text-overflow` is not inherited, so it applied to a box that never
 * overflowed and the ellipsis never appeared: the shipping build cut "Dictate ·
 * shortcut settings are unavailable" to "Dictate · shortcut settings a",
 * mid-word, with nothing to indicate anything was missing.
 *
 * Two separate defects lived here. Making the box a block box restored the
 * ellipsis; widening the hover pill from 146px to 159px is what stopped the
 * everyday shortcut hint needing one at all.
 *
 * The widths below come from `scripts/measure-pill-tooltip-widths.mjs`, which
 * renders each string in Chromium at the shipped `.pill__idle-tooltip` type and
 * then reads pixels to confirm the ellipsis is actually painted. Re-run it when
 * one of these fails.
 */
const MEASURED_TOOLTIP_WIDTHS: Readonly<Record<string, number>> = {
  Scratchpad: 62.0,
  "Choose microphone": 107.4,
  "Close microphone menu": 129.8,
  "Dictate · hold ⌥Space": 118.8,
  "Dictate · hold ⌃⌥⌘F13": 124.5,
  "Dictate · shortcut settings are loading": 203.3,
  "Dictate · shortcut settings are unavailable": 224.4,
  "Dictate · platform details are loading": 195.9,
  "Dictate · platform details are unavailable": 217.0,
  "Dictate · shortcut unavailable on this platform": 245.8,
};

const TOOLTIP_PADDING = 10;
const TOOLTIP_BOX_WIDTH = PILL_LAYOUT.idle.hover.width - 9;
const TOOLTIP_CONTENT_WIDTH = TOOLTIP_BOX_WIDTH - TOOLTIP_PADDING * 2;

const styles = readFileSync("src/renderer/styles.css", "utf8");
const pillSource = readFileSync("src/renderer/pill/Pill.tsx", "utf8");
const rule = sliceFollowing(styles, ".pill__idle-tooltip {", "\n}");

describe("the idle pill tooltip box", () => {
  it("is measured against the width the stylesheet actually gives it", () => {
    expect(rule).toContain("width: calc(var(--pill-idle-hover-width) - 9px)");
    expect(rule).toContain(`padding: 0 ${TOOLTIP_PADDING}px`);
    expect(TOOLTIP_BOX_WIDTH).toBe(150);
    expect(TOOLTIP_CONTENT_WIDTH).toBe(130);
  });

  /*
   * The rule this file exists for. A grid or flex container puts its text in an
   * anonymous item, and `text-overflow` is not inherited, so the declaration
   * below only does anything on a block box.
   */
  it("is a block box, so text-overflow reaches the text", () => {
    expect(rule).toContain("display: block");
    expect(rule).toContain("text-overflow: ellipsis");
    expect(rule).toContain("white-space: nowrap");
    expect(rule).toContain("overflow: hidden");
    expect(rule).not.toContain("display: grid");
    expect(rule).not.toContain("display: flex");
    expect(rule).not.toContain("place-items");
  });

  it("still centres its single line without grid alignment", () => {
    expect(rule).toContain("text-align: center");
    // No border on this box, so line-height and height agree.
    expect(rule).toContain("height: 32px");
    expect(rule).toContain("line-height: 32px");
    // A non-zero border would make the content box shorter than the line box
    // and push the text off centre.
    expect(rule).toMatch(/\bborder: 0;/u);
  });
});

describe("what the tooltip can be asked to show", () => {
  /*
   * Every tooltip the component can produce has to be in the measured table, or
   * the numbers above are describing a set of strings that no longer exists.
   */
  it("measures every tooltip the hover branches can pick", () => {
    // Read the literals out of the expression itself rather than restating
    // them, so rewording one here fails until it has been re-measured.
    const chooser = sliceFollowing(pillSource, "const tooltip = hoveredAction ===", ";\n");
    const produced = [...chooser.matchAll(/"([^"]+)"/gu)]
      .map((match) => match[1])
      .filter((text): text is string => text !== undefined && text !== "scratchpad" && text !== "microphone");

    expect(produced).not.toHaveLength(0);
    const unmeasured = produced.filter((text) => !(text in MEASURED_TOOLTIP_WIDTHS));
    expect(unmeasured, "run scripts/measure-pill-tooltip-widths.mjs and update MEASURED_TOOLTIP_WIDTHS")
      .toEqual([]);
  });

  it("measures every shortcut tooltip the presentation can return", () => {
    const presentation = sliceFollowing(
      pillSource, "): { tooltip: string; dictateAriaLabel: string } {", "\n}\n",
    );
    const produced: string[] = [];
    // `tooltip: "..."` — the fixed one.
    for (const match of presentation.matchAll(/tooltip: "([^"]+)"/gu)) {
      if (match[1] !== undefined) produced.push(match[1]);
    }
    // `tooltip: `Dictate · ${detail}`` — every `detail` the branches assign.
    const details = [...presentation.matchAll(/^\s*\? "([^"]+)"\n\s*: "([^"]+)";$/gmu)]
      .flatMap((match) => [match[1], match[2]])
      .filter((text): text is string => text !== undefined);
    expect(presentation).toContain("tooltip: `Dictate · ${detail}`");
    produced.push(...details.map((detail) => `Dictate · ${detail}`));

    expect(details.length).toBe(2);
    const unmeasured = produced.filter((text) => !(text in MEASURED_TOOLTIP_WIDTHS));
    expect(unmeasured, "run scripts/measure-pill-tooltip-widths.mjs and update MEASURED_TOOLTIP_WIDTHS")
      .toEqual([]);
  });

  it("measures a representative rendered shortcut label", () => {
    // The `Dictate · hold <label>` case is generated, so the table carries the
    // shortest realistic label and the longest a chord can produce.
    expect(pillSource).toContain("tooltip: `Dictate · hold ${label}`");
    expect(MEASURED_TOOLTIP_WIDTHS["Dictate · hold ⌥Space"]).toBeGreaterThan(0);
    expect(MEASURED_TOOLTIP_WIDTHS["Dictate · hold ⌃⌥⌘F13"]).toBeGreaterThan(0);
  });

  /*
   * Every tooltip a working install can show, and the reason the hover pill is
   * 159px rather than 146px. The shortcut hint is the whole point of the idle
   * pill, and at 117px of text it read "Dictate · hold ⌥Spac…".
   */
  const EVERYDAY_TOOLTIPS = [
    "Scratchpad",
    "Choose microphone",
    "Close microphone menu",
    "Dictate · hold ⌥Space",
    "Dictate · hold ⌃⌥⌘F13",
  ] as const;

  it("fits every tooltip a healthy install shows", () => {
    for (const text of EVERYDAY_TOOLTIPS) {
      expect(MEASURED_TOOLTIP_WIDTHS[text], text).toBeLessThanOrEqual(TOOLTIP_CONTENT_WIDTH);
    }
  });

  it("is exactly as wide as the widest of them needs, and no wider", () => {
    // Pins the derivation rather than the number: 159 is the widest everyday
    // tooltip plus the padding and the 9px the box gives back. A reworded or
    // re-measured string moves this, and then the pill has to move with it.
    const needed = Math.ceil(
      Math.max(...EVERYDAY_TOOLTIPS.map((text) => MEASURED_TOOLTIP_WIDTHS[text] ?? 0))
        + TOOLTIP_PADDING * 2 + 9,
    );
    expect(needed).toBe(159);
    expect(PILL_LAYOUT.idle.hover.width).toBe(needed);
    // Still inside the picker, so no other window size had to change.
    expect(PILL_LAYOUT.idle.hover.width).toBeLessThan(PILL_LAYOUT.idle.picker.width);
  });

  /*
   * The five that still overflow are loading/unavailable states, which is why
   * `text-overflow: ellipsis` above is load-bearing rather than decorative.
   * Recorded, not fixed: sizing the pill for "Dictate · shortcut unavailable on
   * this platform" (245.8px) would make the everyday pill nearly twice as wide
   * to accommodate a string no healthy install shows.
   */
  it("still relies on the ellipsis for the states that cannot fit", () => {
    const overflowing = Object.entries(MEASURED_TOOLTIP_WIDTHS)
      .filter(([, width]) => width > TOOLTIP_CONTENT_WIDTH)
      .map(([text]) => text);
    expect(overflowing).toEqual([
      "Dictate · shortcut settings are loading",
      "Dictate · shortcut settings are unavailable",
      "Dictate · platform details are loading",
      "Dictate · platform details are unavailable",
      "Dictate · shortcut unavailable on this platform",
    ]);
  });

  it("gives the full text to anything that can show more than 117px", () => {
    // The native tooltip and the accessible name are not width-limited, so the
    // truncation costs sighted mouse users only.
    expect(pillSource).toContain("title={tooltip}");
    expect(pillSource).toContain("dictateAriaLabel");
  });
});
