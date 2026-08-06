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

/**
 * Properties that move or resize the box the pointer is currently over. A hover
 * rule that changes any of them changes its own hit area, so the pointer can
 * land outside the element that the hover just grew or shifted, which unsets
 * `:hover`, which restores the original geometry, which sets `:hover` again.
 *
 * Regression: the settings cards used `transform: translateY(-1px)` on hover.
 * A pointer resting one pixel inside the bottom edge of a card oscillated at
 * the transition rate for as long as it stayed there — the card flickered and
 * a click landed on whichever phase happened to be current.
 *
 * `box-shadow`, `border-color`, `background`, `opacity`, `color`, and
 * `filter` are all safe: they paint outside or inside the box without moving
 * it, so the hit area under the pointer is unchanged.
 */
const GEOMETRY_PROPERTIES = [
  "transform",
  "translate",
  "scale",
  "rotate",
  "margin",
  "padding",
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "top",
  "right",
  "bottom",
  "left",
  "inset",
  "border-width",
  "font-size",
  "letter-spacing",
  "gap",
  "zoom",
] as const;

const GEOMETRY_DECLARATION = new RegExp(
  String.raw`(?:^|[;{\s])(${GEOMETRY_PROPERTIES.join("|")})(-[a-z-]+)?\s*:\s*([^;}]+)`,
  "gu",
);

function stylesheet(relativePath: string): string {
  // Strip comments so prose describing a property cannot trip the scan.
  return readFileSync(resolve(root, relativePath), "utf8")
    .replace(/\r\n?/gu, "\n")
    .replace(/\/\*[\s\S]*?\*\//gu, "");
}

interface HoverRule {
  readonly selectorList: string;
  readonly body: string;
}

function hoverRules(source: string): HoverRule[] {
  const rules: HoverRule[] = [];
  for (const [, selectorList, body] of source.matchAll(/([^{}]*:hover[^{}]*)\{([^{}]*)\}/gu)) {
    if (selectorList === undefined || body === undefined) continue;
    rules.push({ selectorList, body });
  }
  return rules;
}

/**
 * The element a selector actually styles: its last compound. In
 * `.a:hover .b` the subject is `.b`, not the hovered `.a`.
 */
function subjectOf(selector: string): string {
  return selector.trim().split(/\s+|>|\+|~/u).filter(Boolean).pop() ?? "";
}

/** True when the selector styles the very element carrying `:hover`. */
function stylesTheHoveredElement(selector: string): boolean {
  return subjectOf(selector).includes(":hover");
}

/** A `pointer-events: none` subject cannot re-enter or leave its own hover. */
function isPointerTransparent(source: string, subject: string): boolean {
  const base = subject.replace(/:[a-z-]+(\([^)]*\))?/gu, "").trim();
  if (!base) return false;
  const rule = new RegExp(
    String.raw`(?:^|[,}])[^{}]*${base.replace(/[.[\]()*+?^${}|\\]/gu, "\\$&")}[^{}]*\{([^{}]*)\}`,
    "u",
  );
  const declarations = rule.exec(source)?.[1] ?? "";
  return /pointer-events:\s*none/u.test(declarations);
}

describe("hover stability", () => {
  it("never lets a hover rule move or resize the element under the pointer", () => {
    const offenders: string[] = [];
    for (const relativePath of RENDERER_STYLESHEETS) {
      const source = stylesheet(relativePath);
      for (const { selectorList, body } of hoverRules(source)) {
        const changes = [...body.matchAll(GEOMETRY_DECLARATION)]
          // `transform: none` and `margin: 0` overrides are resets that restore
          // the resting geometry; they cannot introduce a new hit area.
          .filter(([, , , value]) => (value ?? "").trim() !== "none")
          .map(([, property, suffix]) => `${property}${suffix ?? ""}`);
        if (changes.length === 0) continue;

        for (const selector of selectorList.split(",")) {
          const subject = subjectOf(selector);
          if (!subject) continue;
          if (!stylesTheHoveredElement(selector) && isPointerTransparent(source, subject)) {
            // A pointer-events:none descendant (the chart tooltip) may move: it
            // is not hit-testable, so it cannot change what the pointer is over.
            continue;
          }
          offenders.push(
            `${relativePath}: ${selector.trim()} changes ${changes.join(", ")} on hover`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the settings cards on a paint-only hover", () => {
    const source = stylesheet("src/renderer/settings/screens/style-settings.css");
    const cardHover = hoverRules(source).find((rule) =>
      rule.selectorList.includes(".ls-tone-card:hover")
      && rule.selectorList.includes(".ls-cleanup-card:hover")
      && rule.selectorList.includes(".ls-transform-card:hover"),
    );
    expect(cardHover, "the shared settings-card hover rule disappeared").toBeDefined();
    // The affordance is still there — it just does not move the card.
    expect(cardHover?.body).toContain("box-shadow:");
    expect(cardHover?.body).toContain("border-color:");
    expect(cardHover?.body).not.toContain("transform");

    // And the transition must not name a property the rule no longer animates,
    // which is how the reduced-motion audit missed the lift in the first place.
    const base = /\.ls-transform-card\s*\{([^{}]*)\}/u.exec(source)?.[1]
      ?? /\.ls-tone-card,\s*\.ls-cleanup-card,\s*\.ls-transform-card\s*\{([^{}]*)\}/u.exec(source)?.[1]
      ?? "";
    const transition = /transition:\s*([^;}]+)/u.exec(base)?.[1] ?? "";
    expect(transition).not.toContain("transform");
  });
});
