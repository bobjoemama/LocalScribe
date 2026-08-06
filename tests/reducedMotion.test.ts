import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

const RENDERER_STYLESHEETS = [
  "src/renderer/styles.css",
  "src/renderer/settings/screens/style-settings.css",
  "src/renderer/settings/screens/history-insights.css",
  "src/renderer/settings/screens/library-notes.css",
  "src/renderer/scratchpad/scratchpad-window.css",
] as const;

function stylesheet(relativePath: string): string {
  // Strip comments so prose mentioning a selector can never satisfy an
  // assertion that the selector is actually declared.
  return readFileSync(resolve(root, relativePath), "utf8")
    .replace(/\r\n?/gu, "\n")
    .replace(/\/\*[\s\S]*?\*\//gu, "");
}

/**
 * Return the concatenated bodies of every `prefers-reduced-motion: reduce`
 * block in a stylesheet. Brace matching keeps nested rule bodies intact.
 */
function reducedMotionBlocks(source: string): string {
  const blocks: string[] = [];
  const marker = /@media[^{]*prefers-reduced-motion:\s*reduce[^{]*\{/gu;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(source)) !== null) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < source.length && depth > 0) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") depth -= 1;
      index += 1;
    }
    blocks.push(source.slice(start, index - 1));
  }
  return blocks.join("\n");
}

/** Strip every reduced-motion block so only the always-on rules remain. */
function withoutReducedMotion(source: string): string {
  const blocks = reducedMotionBlocks(source);
  return blocks ? source.split(blocks).join("\n") : source;
}

describe("reduced-motion coverage", () => {
  /*
   * The per-stylesheet case above short-circuits when a sheet declares no
   * motion. That is correct per sheet but means the whole suite could quietly
   * degrade to zero real assertions — every sheet renamed, every read empty,
   * green. Prove the interesting branch is still being taken.
   */
  it("actually exercises the animated branch on the shipped stylesheets", () => {
    const animatedSheets = RENDERER_STYLESHEETS.filter((relativePath) =>
      /(?:^|[;{\s])(?:transition|animation):/mu.test(withoutReducedMotion(stylesheet(relativePath))),
    );

    expect(animatedSheets.length).toBeGreaterThan(0);
    for (const relativePath of animatedSheets) {
      expect(reducedMotionBlocks(stylesheet(relativePath)).trim().length).toBeGreaterThan(0);
    }
  });

  it.each(RENDERER_STYLESHEETS)(
    "%s stills its animated rules when the user asks for reduced motion",
    (relativePath) => {
      const source = stylesheet(relativePath);
      const alwaysOn = withoutReducedMotion(source);
      const animated = /(?:^|[;{\s])(?:transition|animation):/mu.test(alwaysOn);
      if (!animated) {
        /*
         * "Nothing to still" is a legitimate outcome, but a bare `return` made
         * it indistinguishable from a stylesheet that had been renamed, emptied,
         * or read as "". Say what was actually proved.
         */
        expect(source.trim().length, `${relativePath} is empty or unreadable`).toBeGreaterThan(0);
        expect(alwaysOn).not.toMatch(/(?:^|[;{\s])(?:transition|animation):/mu);
        return;
      }

      // Regression: style-settings.css declared four transitions — including a
      // hover lift and the sliding toggle knob — with no reduced-motion block
      // at all, so the settings surface animated regardless of the preference.
      expect(
        reducedMotionBlocks(source).trim().length,
        `${relativePath} animates but declares no prefers-reduced-motion block`,
      ).toBeGreaterThan(0);
    },
  );

  it("neutralises every hover rule that moves an element with a transform", () => {
    // A hover `transform` is motion under a stationary pointer, so each such
    // selector must be reset inside the stylesheet's reduced-motion block.
    const offenders: string[] = [];
    for (const relativePath of RENDERER_STYLESHEETS) {
      const source = stylesheet(relativePath);
      const alwaysOn = withoutReducedMotion(source);
      const reduced = reducedMotionBlocks(source);

      const hoverRules = alwaysOn.matchAll(
        /([^{}]*:hover[^{}]*)\{([^{}]*)\}/gu,
      );
      for (const [, selectorList, body] of hoverRules) {
        if (selectorList === undefined || body === undefined) continue;
        // Read the declared value; `transform: none` is a reset, not motion.
        const declaration = /transform:\s*([^;}]+)/u.exec(body);
        const value = declaration?.[1]?.trim();
        if (value === undefined || value === "none") continue;
        for (const selector of selectorList.split(",")) {
          // The element that actually moves is the subject of the selector —
          // its last compound — not the ancestor carrying `:hover`.
          const subject = selector.trim().split(/\s+|>/u).filter(Boolean).pop();
          if (!subject) continue;
          const base = subject.replace(/:hover.*$/u, "").trim();
          if (!base) continue;
          if (!reduced.includes(base)) {
            offenders.push(`${relativePath}: ${base} moves via transform on hover`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("stills the specific surfaces that previously kept animating", () => {
    // Each of these was a real gap: the selector animated but was not listed
    // in (or not matched by) its stylesheet's reduced-motion block.
    const pill = reducedMotionBlocks(stylesheet("src/renderer/styles.css"));
    expect(pill).toContain(".pill__idle-rail");

    const insights = reducedMotionBlocks(
      stylesheet("src/renderer/settings/screens/history-insights.css"),
    );
    // `.hi-chart-bars i` never matched the tooltip, which is a <span>.
    expect(insights).toContain(".hi-chart-tooltip");

    const settings = reducedMotionBlocks(
      stylesheet("src/renderer/settings/screens/style-settings.css"),
    );
    expect(settings).toContain(".ls-switch::after");
    expect(settings).toContain(".ls-transform-card");
  });
});
