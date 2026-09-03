import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Pill } from "../src/renderer/pill/Pill";

describe("pill accessibility", () => {
  it("exposes microphone selection as a dedicated disclosure button", () => {
    const html = renderToStaticMarkup(createElement(Pill));

    expect(html).toContain('aria-label="Choose microphone"');
    expect(html).toContain('aria-controls="pill-microphone-picker"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("keeps focus indication in-bounds and stops the error countdown for reduced motion", () => {
    const css = readFileSync(resolve(process.cwd(), "src/renderer/styles.css"), "utf8");
    const reducedMotion = css.match(
      /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(css).toContain(".pill__round:focus-visible { outline-offset: -2px; }");
    expect(reducedMotion).toContain(".pill-error-notice__countdown-progress");
  });

  it("makes the Live transcript keyboard-reviewable with a visible scrollbar", () => {
    const source = readFileSync(resolve(process.cwd(), "src/renderer/pill/Pill.tsx"), "utf8");
    const css = readFileSync(resolve(process.cwd(), "src/renderer/styles.css"), "utf8");
    const liveTranscript = source.slice(
      source.indexOf('className="pill__live-transcript"'),
      source.indexOf("<span>{transcript", source.indexOf('className="pill__live-transcript"')),
    );
    const transcriptRule = css.match(/\.pill__live-transcript\s*\{([\s\S]*?)\n\}/)?.[1];

    expect(liveTranscript).toContain('role="region"');
    expect(liveTranscript).toContain('aria-label="Live transcript. Scroll to review earlier words."');
    expect(liveTranscript).toContain("tabIndex={0}");
    expect(liveTranscript).toContain("isLiveTranscriptNearBottom(event.currentTarget)");
    expect(transcriptRule).toContain("scrollbar-width: thin");
    expect(css).toContain(".pill__live-transcript::-webkit-scrollbar { width: 7px; }");
    expect(css).toContain(".pill__live-transcript:focus-visible");
    expect(css).not.toContain(".pill__live-transcript::-webkit-scrollbar { display: none; }");
  });

  it("uses the native macOS UI font before the generic fallback", () => {
    const css = readFileSync(resolve(process.cwd(), "src/renderer/styles.css"), "utf8");

    expect(css).toMatch(
      /\.pill\s*\{[\s\S]*?"SF Pro Text", sans-serif;/,
    );
    expect(css).toMatch(
      /\.pill-error-stack\s*\{[\s\S]*?"SF Pro Text", sans-serif;/,
    );
  });

  it("bounds runtime shortcut copy to the shared pill width", () => {
    const css = readFileSync(resolve(process.cwd(), "src/renderer/styles.css"), "utf8");
    const tooltipRule = css.match(/\.pill__idle-tooltip\s*\{([\s\S]*?)\n\}/)?.[1];
    const pickerRule = css.match(/\.pill__microphone-menu\s*\{([\s\S]*?)\n\}/)?.[1];

    expect(tooltipRule).toContain("width: calc(var(--pill-idle-hover-width) - 9px)");
    expect(tooltipRule).toContain("overflow: hidden");
    expect(tooltipRule).toContain("text-overflow: ellipsis");
    expect(tooltipRule).toContain("white-space: nowrap");
    expect(pickerRule).toContain("bottom: calc(var(--pill-idle-hover-height) + 2px)");
    expect(pickerRule).toContain("width: calc(var(--pill-idle-picker-width) - 8px)");
    expect(pickerRule).toContain(
      "max-height: calc(var(--pill-idle-picker-height) - var(--pill-idle-hover-height) - 6px)",
    );
  });

  it("keeps application controls on the arrow cursor while preserving text editing", () => {
    const css = readFileSync(resolve(process.cwd(), "src/renderer/styles.css"), "utf8");

    expect(css).toMatch(
      /body :where\(\*, \*::before, \*::after\)\s*\{ cursor: default !important; \}/,
    );
    expect(css).toMatch(/textarea:not\(:disabled\),[\s\S]*\{ cursor: text !important; \}/);
    expect(css).not.toMatch(/cursor:\s*(?:pointer|wait|not-allowed)\s*!important/);
    /*
     * The I-beam must not be promised over a field that cannot be typed into.
     * Because the rule is `!important`, a surface cannot opt out with a normal
     * declaration — the scratchpad's `textarea:disabled { cursor: default }`
     * was silently dead — so the exception belongs in this rule itself.
     */
    const ibeamSelector = css.slice(
      css.indexOf("body :where(\n  input:not("),
      css.indexOf("{ cursor: text !important; }"),
    );
    expect(ibeamSelector).toContain("textarea:not(:disabled)");
    expect(ibeamSelector).toContain(":not(:disabled),\n");
  });
});
