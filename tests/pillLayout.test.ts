import { describe, expect, it } from "vitest";
import type { CSSProperties } from "react";
import { ERROR_NOTICE_DURATION_MS } from "../src/shared/dictationErrors";
import {
  pillErrorCountdownCssProperties,
  PILL_ERROR_NOTICE_DURATION_CSS_VARIABLE,
  PILL_LAYOUT,
  PILL_LAYOUT_CSS_PROPERTIES,
  pillSizeFor,
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
