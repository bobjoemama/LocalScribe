import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expectPrecedes, sliceBetween } from "./support/order";
import type { CSSProperties } from "react";
import { ERROR_NOTICE_DURATION_MS } from "../src/shared/dictationErrors";
import type { PillMode } from "../src/shared/contracts";
import {
  pillErrorCountdownCssProperties,
  PILL_HOVER_HIT_PADDING,
  PILL_WINDOW_BOTTOM_MARGIN,
  pillHoverModeForPointer,
  PILL_ERROR_NOTICE_DURATION_CSS_VARIABLE,
  PILL_LAYOUT,
  PILL_LAYOUT_CSS_PROPERTIES,
  pillSizeFor,
  rendererPillModeForMainMode,
  STATUS_CHROME_WIDTH,
  STATUS_COPY_WIDTH,
} from "../src/shared/pillLayout";

describe("pill layout contract", () => {
  it("returns the exact native-window size for each renderer state", () => {
    expect(pillSizeFor("idle")).toEqual(PILL_LAYOUT.idle.collapsed);
    expect(pillSizeFor("idle", "hover")).toEqual(PILL_LAYOUT.idle.hover);
    expect(pillSizeFor("idle", "picker")).toEqual(PILL_LAYOUT.idle.picker);
    expect(pillSizeFor("listening", "collapsed", "hold")).toEqual(PILL_LAYOUT.listening.hold);
    expect(pillSizeFor("listening", "collapsed", "toggle")).toEqual(PILL_LAYOUT.listening.toggle);
    expect(pillSizeFor("error")).toEqual(PILL_LAYOUT.error.stack);
    expect(pillSizeFor("transcribing")).toEqual(PILL_LAYOUT.status);
  });

  it("exposes the shared renderer dimensions as CSS variables", () => {
    expect(PILL_LAYOUT_CSS_PROPERTIES["--pill-idle-collapsed-width"]).toBe("40px");
    expect(PILL_LAYOUT_CSS_PROPERTIES["--pill-error-stack-height"]).toBe("100px");
  });

  it("derives the countdown animation duration from the main error timeout", () => {
    const properties = pillErrorCountdownCssProperties() as CSSProperties & Record<string, string>;
    expect(properties[PILL_ERROR_NOTICE_DURATION_CSS_VARIABLE]).toBe(`${ERROR_NOTICE_DURATION_MS}ms`);
    expect(pillErrorCountdownCssProperties(725)[PILL_ERROR_NOTICE_DURATION_CSS_VARIABLE]).toBe("725ms");
  });
});

/*
 * The status pill is a fixed-width window, so it can only be as readable as the
 * number in `PILL_LAYOUT.status`. It shipped at 128px, which left 56px of copy —
 * about ten characters — so ordinary dictations read "Transcribin…" and the one
 * message that tells a macOS user automatic paste degraded to clipboard-only,
 * "Copied — allow Accessibility", was unreadable.
 *
 * These widths come from `scripts/measure-pill-status-widths.mjs`, which renders
 * each string in Chromium at the shipped `.pill__status-copy` type. The tests
 * below fail if a message is added or reworded, if the chrome around the copy
 * changes, or if the type changes — each of which invalidates the measurement.
 */
const MEASURED_STATUS_COPY_WIDTHS: Readonly<Record<string, number>> = {
  Ready: 32,
  Listening: 47,
  Finishing: 46,
  "Finishing recording": 97,
  Transcribing: 64,
  "Transcribing locally": 99,
  Inserting: 46,
  Copying: 42,
  Inserted: 43,
  "Inserted · copied as backup": 139,
  "Copied to clipboard": 99,
  "Copied — allow Accessibility": 143,
  Done: 27,
  "Try again": 47,
};

const mainSource = readFileSync("src/main.ts", "utf8");
const pillSource = readFileSync("src/renderer/pill/Pill.tsx", "utf8");
const stylesheet = readFileSync("src/renderer/styles.css", "utf8");

/** Every literal the main process can put in `SessionSnapshot.message`. */
function statusMessagesFromMain(): Set<string> {
  const messages = new Set<string>();
  const collect = (text: string): void => {
    const withoutOperands = text
      .replace(/state:\s*"[^"]*"/g, "")
      .replace(/[!=]==\s*"[^"]*"/g, "");
    for (const match of withoutOperands.matchAll(/"([^"\\]*)"/g)) {
      if (match[1]) messages.add(match[1]);
    }
  };

  for (const call of mainSource.matchAll(/setSession\(\{/g)) {
    const open = mainSource.indexOf("{", call.index);
    let depth = 0;
    for (let index = open; index < mainSource.length; index += 1) {
      if (mainSource[index] === "{") depth += 1;
      else if (mainSource[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          const body = mainSource.slice(open, index + 1);
          if (body.includes("message")) collect(body);
          break;
        }
      }
    }
  }
  // The success copy is assembled into a local before it reaches setSession.
  for (const assignment of mainSource.matchAll(/const \w*[Mm]essage\w* =([\s\S]*?);\n/g)) {
    collect(assignment[1] ?? "");
  }
  return messages;
}

/** The renderer's per-state fallbacks, used whenever `message` is empty. */
function statusFallbacksFromRenderer(): Set<string> {
  const body = pillSource.slice(pillSource.indexOf("function label(snapshot: SessionSnapshot)"));
  const fallbacks = new Set<string>();
  for (const match of body.slice(0, body.indexOf("\n}")).matchAll(/return "([^"]+)";/g)) {
    if (match[1]) fallbacks.add(match[1]);
  }
  return fallbacks;
}

function cssRule(selector: string): string {
  const start = stylesheet.indexOf(`${selector} {`);
  expect(start, `missing stylesheet rule: ${selector}`).toBeGreaterThanOrEqual(0);
  return stylesheet.slice(start, stylesheet.indexOf("}", start));
}

/*
 * The pill window is transparent, always-on-top, and mouse-opaque, and nothing
 * in the app ever calls setIgnoreMouseEvents. So any moment the window is larger
 * than what the renderer is drawing is a moment it silently eats clicks meant
 * for the app behind it — near the Dock, that is the Dock.
 */
describe("pill hover window sizing", () => {
  const workArea = { x: 0, y: 25, width: 1728, height: 1079 };
  const bottom = workArea.y + workArea.height - PILL_WINDOW_BOTTOM_MARGIN;
  const boundsFor = (size: { width: number; height: number }) => ({
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: bottom - size.height,
    width: size.width,
    height: size.height,
  });
  const collapsed = boundsFor(PILL_LAYOUT.idle.collapsed);
  const hover = boundsFor(PILL_LAYOUT.idle.hover);
  const decide = (mode: PillMode, cursor: { x: number; y: number }, windowBounds = collapsed) =>
    pillHoverModeForPointer({ mode, cursor, windowBounds, hoverBounds: hover });

  it("expands from the forgiving hit padding around the 40x8 rail", () => {
    const centre = { x: collapsed.x + 20, y: collapsed.y + 4 };
    expect(decide("collapsed", centre)).toBe("hover");
    expect(decide("collapsed", { x: collapsed.x - 6, y: collapsed.y - 6 })).toBe("hover");
    expect(decide("collapsed", { x: collapsed.x + 20, y: collapsed.y - 9 })).toBe("hover");
  });

  it("does not expand into padding the expanded window will not cover", () => {
    // Leaving the pill downward toward the Dock. The window is bottom anchored,
    // so growing to 159x64 adds nothing below this point.
    const belowTheRail = { x: collapsed.x + 20, y: collapsed.y + collapsed.height + 5 };
    expect(belowTheRail.y).toBeLessThan(collapsed.y + collapsed.height + PILL_HOVER_HIT_PADDING);
    expect(decide("collapsed", belowTheRail)).toBe("collapsed");
  });

  it("contracts as soon as the pointer is off the expanded window", () => {
    expect(decide("hover", { x: hover.x + 70, y: hover.y + 30 }, hover)).toBe("hover");
    expect(decide("hover", { x: hover.x + 70, y: bottom + 4 }, hover)).toBe("collapsed");
    expect(decide("hover", { x: hover.x - 4, y: hover.y + 30 }, hover)).toBe("collapsed");
    expect(decide("hover", { x: hover.x + 70, y: hover.y - 4 }, hover)).toBe("collapsed");
  });

  it("cannot oscillate: every pointer that expands is inside the expanded window", () => {
    for (let x = collapsed.x - 40; x < collapsed.x + collapsed.width + 40; x += 1) {
      for (let y = collapsed.y - 40; y < bottom + 40; y += 1) {
        const cursor = { x, y };
        if (decide("collapsed", cursor) !== "hover") continue;
        expect(
          decide("hover", cursor, hover),
          `expanding at ${x},${y} would immediately contract`,
        ).toBe("hover");
      }
    }
  });

  it("leaves a renderer-owned picker alone", () => {
    expect(decide("picker", { x: 0, y: 0 })).toBe("picker");
  });
});

/*
 * Main resizes the transparent window from the real cursor position; the
 * renderer decides what is drawn in it. Those two views desynchronise unless
 * main reports what it committed, because resizing a window under a stationary
 * pointer produces no pointerenter/pointerleave.
 *
 * The visible case: choosing a microphone returns the pill to `hover`, but the
 * pointer is still where the 212px picker was — far above the 64px hover box —
 * so the poller contracts to the 40x8 rail on its next tick. Before this, the
 * renderer kept `visualMode: "hover"` and `pointerInside: true`, so the whole
 * expanded control stayed mounted and clipped inside the rail.
 */
describe("pill mode reported by main", () => {
  it("follows main into and out of the expanded window", () => {
    expect(rendererPillModeForMainMode("hover", "collapsed")).toBe("collapsed");
    expect(rendererPillModeForMainMode("collapsed", "hover")).toBe("hover");
    expect(rendererPillModeForMainMode("collapsed", "collapsed")).toBe("collapsed");
  });

  it("never closes a picker the user is reading", () => {
    expect(rendererPillModeForMainMode("picker", "collapsed")).toBe("picker");
    expect(rendererPillModeForMainMode("picker", "hover")).toBe("picker");
  });

  it("is actually wired from the poller to the pill", () => {
    const preloadSource = readFileSync("src/preload.ts", "utf8");
    const contractsSource = readFileSync("src/shared/contracts.ts", "utf8");

    expect(contractsSource).toContain('windowPillMode: "window:pill-mode"');
    // The renderer must validate the pushed mode like every other channel.
    expect(preloadSource).toMatch(
      /onPillModeChanged:[\s\S]*?pillModeSchema\.parse\(mode\)[\s\S]*?ipcRenderer\.on\(IPC\.windowPillMode/,
    );
    /*
     * And main must report only after it commits, so the two cannot disagree.
     *
     * This was `indexOf("resizePill();") < indexOf("send(IPC.windowPillMode")`,
     * which passes when `resizePill()` is *deleted* — -1 is less than any real
     * index. Removing it leaves main announcing the new mode while the window
     * keeps its old size, so the renderer draws the hover layout inside the
     * collapsed rail: the exact disagreement this test exists to prevent, and
     * one that has shipped before. `sliceBetween`/`expectPrecedes` also stop
     * the slice from silently widening to the rest of main.ts if either
     * function is renamed.
     */
    const poller = sliceBetween(
      mainSource,
      "function followPillHover",
      "function startPillDisplayFollowing",
      "src/main.ts",
    );
    expect(poller).toContain("pillMode = next;");
    expectPrecedes(poller, "resizePill();", "send(IPC.windowPillMode", "followPillHover");
    expect(pillSource).toContain("rendererPillModeForMainMode(visualModeRef.current, mode)");
  });
});

describe("pill status width contract", () => {
  it("is wide enough for every status string the product can display", () => {
    const widest = Math.max(...Object.values(MEASURED_STATUS_COPY_WIDTHS));
    expect(STATUS_COPY_WIDTH).toBe(widest);
    expect(PILL_LAYOUT.status.width).toBe(STATUS_COPY_WIDTH + STATUS_CHROME_WIDTH);

    // The regression the box shipped with: the most common message alone needs
    // more room than the whole window used to have.
    const ordinaryDictation = MEASURED_STATUS_COPY_WIDTHS["Transcribing locally"] ?? 0;
    expect(ordinaryDictation + STATUS_CHROME_WIDTH).toBeGreaterThan(128);

    for (const [message, copyWidth] of Object.entries(MEASURED_STATUS_COPY_WIDTHS)) {
      expect(
        PILL_LAYOUT.status.width - STATUS_CHROME_WIDTH,
        `"${message}" would be ellipsized`,
      ).toBeGreaterThanOrEqual(copyWidth);
    }
  });

  it("pins the producible status strings so a new message forces a re-measure", () => {
    const producible = new Set([...statusMessagesFromMain(), ...statusFallbacksFromRenderer()]);
    expect(producible.size).toBeGreaterThan(0);
    const unmeasured = [...producible].filter((message) => !(message in MEASURED_STATUS_COPY_WIDTHS));
    expect(
      unmeasured,
      "run scripts/measure-pill-status-widths.mjs and update MEASURED_STATUS_COPY_WIDTHS",
    ).toEqual([]);
  });

  it("re-derives the chrome around the copy from the shipped stylesheet", () => {
    const container = cssRule(".pill--status");
    const padding = /padding:\s*0\s+(\d+)px\s+0\s+(\d+)px/.exec(container);
    const gap = /gap:\s*(\d+)px/.exec(container);
    expect(padding).not.toBeNull();
    expect(gap).not.toBeNull();

    const markWidth = /width:\s*(\d+)px/.exec(cssRule(".pill__status-mark"));
    const closeWidth = /width:\s*(\d+)px/.exec(cssRule(".pill__status-close"));
    expect(markWidth).not.toBeNull();
    expect(closeWidth).not.toBeNull();

    const derived = Number(padding![1]) + Number(padding![2])
      + Number(markWidth![1]) + Number(closeWidth![1])
      + Number(gap![1]) * 2;
    expect(derived).toBe(STATUS_CHROME_WIDTH);
  });

  it("keeps the measured type, and keeps the full string reachable if it ever overflows", () => {
    const copy = cssRule(".pill__status-copy");
    expect(copy).toContain("font-size: 10px");
    expect(copy).toContain("font-weight: 600");
    expect(copy).toContain("text-overflow: ellipsis");
    expect(pillSource).toContain('className="pill__status-copy" title={status}');
  });
});
