/**
 * Measures every tooltip the idle pill can display, in Chromium, at the exact
 * rules shipped by `.pill__idle-tooltip`, and checks that an over-wide one is
 * ellipsised rather than cut mid-glyph.
 *
 *   npx electron scripts/measure-pill-tooltip-widths.mjs
 *
 * The tooltip box is `--pill-idle-hover-width - 9px` with 10px of padding on
 * each side, so the text gets that width minus 29 — 130px at the current 159px
 * hover pill. Anything wider is truncated, and the only way to know which
 * strings that covers is to measure.
 *
 * `tests/pillTooltipWidths.test.ts` pins the table this prints. When it fails
 * because a tooltip was added or reworded, re-run this and update the pinned
 * table — and if the everyday "Dictate · hold <shortcut>" case has grown past
 * the box, widen PILL_LAYOUT.idle.hover rather than accepting the truncation.
 *
 * The ellipsis check reads pixels, because `text-overflow` changes painting and
 * not layout: `Range.getBoundingClientRect()` reports the same geometry whether
 * or not it applies. That is what hid the original defect — `display: grid` put
 * the text in an anonymous grid item, `text-overflow` is not inherited, and so
 * the declaration on this box did nothing at all.
 */
import { app, BrowserWindow } from "electron";

/** Kept in sync with the pinned set in tests/pillTooltipWidths.test.ts. */
const TOOLTIPS = [
  "Scratchpad",
  "Choose microphone",
  "Close microphone menu",
  "Dictate · hold ⌥Space",
  "Dictate · hold ⌃⌥⌘F13",
  "Dictate · shortcut settings are loading",
  "Dictate · shortcut settings are unavailable",
  "Dictate · platform details are loading",
  "Dictate · platform details are unavailable",
  "Dictate · shortcut unavailable on this platform",
];

const HOVER_WIDTH = 159; // PILL_LAYOUT.idle.hover.width
const BOX_WIDTH = HOVER_WIDTH - 9;
const PADDING = 10;
const CONTENT_WIDTH = BOX_WIDTH - PADDING * 2;

/** Verbatim from `.pill__idle-tooltip` in src/renderer/styles.css. */
const TOOLTIP_RULES = `
  display: block;
  width: ${BOX_WIDTH}px;
  height: 32px;
  overflow: hidden;
  padding: 0 ${PADDING}px;
  text-align: center;
  line-height: 32px;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", sans-serif;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: -.1px;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const PAGE = `
<style>
  /* Global in src/renderer/styles.css, and what makes the 137px width
     include the 10px of padding rather than sit outside it. */
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; overflow: hidden; }
  .tooltip { ${TOOLTIP_RULES} color: #000; background: #fff; }
  .probe {
    position: absolute; top: 200px; visibility: hidden; white-space: nowrap;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", sans-serif;
    font-size: 11px; font-weight: 600; letter-spacing: -.1px;
  }
</style>
<div id="host"></div>
<span id="probe" class="probe"></span>
`;

const MEASURE = `(() => {
  const host = document.getElementById("host");
  const probe = document.getElementById("probe");
  return ${JSON.stringify(TOOLTIPS)}.map((text) => {
    probe.textContent = text;
    const natural = probe.getBoundingClientRect().width;
    host.replaceChildren();
    const span = document.createElement("span");
    span.className = "tooltip";
    span.textContent = text;
    host.appendChild(span);
    return { text, natural };
  });
})()`;

/** Renders one tooltip alone at the top-left and returns its painted columns. */
function showOne(text) {
  return `(() => {
    const host = document.getElementById("host");
    host.replaceChildren();
    const span = document.createElement("span");
    span.className = "tooltip";
    span.textContent = ${JSON.stringify(text)};
    host.appendChild(span);
    return true;
  })()`;
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 200, height: 160 });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);

  const rows = await window.webContents.executeJavaScript(MEASURE);

  console.log(`box ${BOX_WIDTH}px, padding ${PADDING}px each side -> ${CONTENT_WIDTH}px for text\n`);
  console.log(`${"tooltip".padEnd(50)}${"width".padStart(8)}  ${"over by".padStart(8)}`);
  const overflowing = [];
  for (const { text, natural } of rows) {
    const over = natural - CONTENT_WIDTH;
    if (over > 0.5) overflowing.push(text);
    console.log(
      `${(over > 0.5 ? "! " : "  ") + text.padEnd(48)}${natural.toFixed(1).padStart(8)}  ` +
      `${over > 0.5 ? `${over.toFixed(1)}px`.padStart(8) : "-".padStart(8)}`,
    );
  }
  console.log(`\n${overflowing.length} of ${rows.length} tooltips are wider than the box.`);

  // Paint check on the longest one: an applied ellipsis leaves clear space
  // before the clipping edge, a hard clip runs ink into it.
  const longest = rows.reduce((a, b) => (a.natural >= b.natural ? a : b));
  await window.webContents.executeJavaScript(showOne(longest.text));
  const image = await window.webContents.capturePage();
  const { width, height } = image.getSize();
  if (process.env.TOOLTIP_PNG) (await import("node:fs")).writeFileSync(process.env.TOOLTIP_PNG, image.toPNG());
  // The capture covers the whole viewport, not just the tooltip, so the CSS-px
  // scale comes from the viewport width rather than from the box.
  const viewportWidth = await window.webContents.executeJavaScript("window.innerWidth");
  const scale = width / viewportWidth;
  const bitmap = image.toBitmap(); // BGRA
  // Only the tooltip's own box: the viewport is wider than it, and a scrollbar
  // or anything else painted to its right would be read as tooltip ink.
  const right = Math.min(width, Math.round(BOX_WIDTH * scale));
  const bottom = Math.min(height, Math.round(32 * scale));
  let lastInk = null;
  for (let x = 0; x < right; x += 1) {
    for (let y = 0; y < bottom; y += 1) {
      const offset = (y * width + x) * 4;
      if (bitmap[offset] < 200 || bitmap[offset + 1] < 200 || bitmap[offset + 2] < 200) {
        lastInk = x / scale;
        break;
      }
    }
  }

  const clippingEdge = BOX_WIDTH;
  const gap = clippingEdge - (lastInk ?? 0);
  console.log(`\npaint check on ${JSON.stringify(longest.text)} (${longest.natural.toFixed(1)}px):`);
  console.log(`  last painted column ${lastInk?.toFixed(1)}px, clipping edge ${clippingEdge}px, gap ${gap.toFixed(1)}px`);
  if (gap < 2) {
    console.log("  FAIL: ink runs into the clipping edge — text-overflow is not applying.");
    app.exit(1);
    return;
  }
  console.log("  ok: the text stops short of the edge, so the ellipsis is being painted.");
  app.exit(0);
});
