import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MAX_HISTORY_ITEMS, type Transcription } from "../src/shared/contracts";
import {
  ActivityChart,
  CategoryList,
  HistoryNoticeSurface,
  HistoryScreen,
  InsightsScreen,
  activityBarHeightPercent,
  createLatestRequestGate,
  historyErrorMessage,
  historyFailureNotice,
  historySampleLabel,
  historySuccessNotice,
  historyStoragePresentation,
  insightTabForKey,
  summarizeTranscriptions,
} from "../src/renderer/settings/screens/HistoryInsights";

const insightsCss = readFileSync(
  resolve(process.cwd(), "src/renderer/settings/screens/history-insights.css"),
  "utf8",
);

function transcript(overrides: Partial<Transcription> = {}): Transcription {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date(2026, 6, 22, 12).getTime(),
    durationMs: 60_000,
    text: "one two three",
    language: "en",
    modelId: "test",
    status: "complete",
    sourceAppId: "com.apple.Safari",
    ...overrides,
  };
}

describe("History Insights interaction and data presentation", () => {
  it("keeps only the newest concurrent history load eligible to update state", () => {
    const gate = createLatestRequestGate();
    const initialLoad = gate.begin();
    const changedLoad = gate.begin();

    expect(gate.isLatest(initialLoad)).toBe(false);
    expect(gate.isLatest(changedLoad)).toBe(true);

    gate.invalidate();
    expect(gate.isLatest(changedLoad)).toBe(false);
  });

  it("implements the expected arrow, Home, and End tab navigation", () => {
    expect(insightTabForKey("usage", "ArrowRight")).toBe("voice");
    expect(insightTabForKey("usage", "ArrowLeft")).toBe("voice");
    expect(insightTabForKey("voice", "ArrowRight")).toBe("usage");
    expect(insightTabForKey("voice", "Home")).toBe("usage");
    expect(insightTabForKey("usage", "End")).toBe("voice");
    expect(insightTabForKey("usage", "Tab")).toBeNull();
  });

  it("keeps both controlled tabpanels mounted and hides only the inactive panel", () => {
    const html = renderToStaticMarkup(createElement(InsightsScreen));

    expect(html).toMatch(/id="usage-tab"[^>]*aria-selected="true"[^>]*tabindex="0"/);
    expect(html).toMatch(/id="voice-tab"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
    expect(html).toMatch(/id="usage-panel"[^>]*role="tabpanel"[^>]*tabindex="0"/);
    expect(html).toMatch(/id="voice-panel"[^>]*role="tabpanel"[^>]*hidden=""[^>]*tabindex="-1"/);
  });

  it("renders shortcut loading copy as status text instead of a keyboard key", () => {
    const html = renderToStaticMarkup(createElement(HistoryScreen));

    expect(html).toContain('class="hi-shortcut-status" role="status"');
    expect(html).toContain("Shortcut settings are loading");
    expect(html).not.toContain("<kbd>Shortcut settings are loading</kbd>");
  });

  it("connects each keyboard-focusable chart point to its tooltip without drawing activity for zero words", () => {
    const html = renderToStaticMarkup(createElement(ActivityChart, {
      points: [
        { key: "2026-07-21", words: 0, label: "T", fullLabel: "Jul 21" },
        { key: "2026-07-22", words: 4, label: "W", fullLabel: "Jul 22" },
      ],
    }));

    expect(html).toContain('aria-label="Dictated words over time"');
    expect(html).toMatch(/role="img"[^>]*tabindex="0"[^>]*aria-label="Jul 21"[^>]*aria-describedby="hi-chart-tooltip-2026-07-21"/);
    expect(html).toContain('id="hi-chart-tooltip-2026-07-21" role="tooltip"');
    expect(html).toContain("height:0%");
    expect(activityBarHeightPercent(0, 4)).toBe(0);
    expect(activityBarHeightPercent(1, 100)).toBe(5);
    expect(insightsCss).toContain(".hi-chart-column:focus-visible .hi-chart-tooltip");
  });

  it("does not double-count the same captured app when identifier casing differs", () => {
    const summary = summarizeTranscriptions([
      transcript({ sourceAppId: "com.apple.Safari" }),
      transcript({ sourceAppId: "COM.APPLE.SAFARI" }),
      transcript({ sourceAppId: "  com.apple.Safari  " }),
    ]);

    expect(summary.appCount).toBe(1);
    expect(summary.words).toBe(9);
  });

  it("describes the actual history sample instead of a fixture-like fixed total", () => {
    expect(historySampleLabel(12)).toBe("12 saved");
    expect(historySampleLabel(MAX_HISTORY_ITEMS)).toBe(`Latest ${MAX_HISTORY_ITEMS}`);
    expect(historySampleLabel(MAX_HISTORY_ITEMS + 400)).toBe(`Latest ${MAX_HISTORY_ITEMS}`);
  });

  it("derives history and Insights availability copy from the persisted history setting", () => {
    expect(historyStoragePresentation(false)).toMatchObject({
      status: "History saving off",
      emptyTitle: "Transcript history saving is off",
      insightsEmptyBody: "Turn on Save transcript history in Settings to build local usage insights.",
    });
    expect(historyStoragePresentation(true)).toMatchObject({
      status: "Encrypted history",
      emptyTitle: "Your first dictation will appear here",
    });
    expect(historyStoragePresentation("loading")).toMatchObject({
      status: "Checking history setting",
      emptyTitle: "Checking history settings",
    });
    expect(historyStoragePresentation("unavailable")).toMatchObject({
      status: "Local encrypted storage",
      emptyTitle: "No saved dictations yet",
    });
  });

  it("keeps technical and path-bearing history failures out of visible notices", () => {
    expect(historyErrorMessage(
      new Error("EPERM: failed to export /Users/Alice/Documents/history.json"),
      "History could not be exported.",
    )).toBe("History could not be exported.");
    expect(historyErrorMessage(
      new Error("Clipboard is temporarily unavailable."),
      "Could not copy to the clipboard.",
    )).toBe("Clipboard is temporarily unavailable.");
  });

  /*
   * The message an action produces was written into `.hi-live-region`, and that
   * class is `position: fixed; left: -9999px`. So "The transcript could not be
   * deleted." was rendered 9999 pixels to the left of the window: a sighted
   * user clicked Delete, the row stayed, and no surface in the app said why.
   * Copy, clear, and export failed the same silent way.
   */
  describe("history action outcomes", () => {
    const offScreenClasses = ["hi-live-region", "hi-visually-hidden"];

    /* Every class the CSS file positions or clips out of view. */
    function isHiddenByStylesheet(className: string): boolean {
      const start = insightsCss.indexOf(`.${className} {`);
      if (start < 0) return false;
      const rule = insightsCss.slice(start, insightsCss.indexOf("}", start));
      return /left: -\d{3,}px|display: none|visibility: hidden|clip: rect\(0 0 0 0\)/u.test(rule);
    }

    it("renders a failure in the layout instead of off-screen", () => {
      const html = renderToStaticMarkup(createElement(HistoryNoticeSurface, {
        notice: historyFailureNotice(new Error("database is locked"), "The transcript could not be deleted."),
        onDismiss: () => undefined,
      }));

      expect(html).toContain("database is locked");
      // The message must not be inside the off-screen paragraph.
      const liveRegion = html.slice(html.indexOf('class="hi-live-region"'));
      expect(liveRegion).not.toContain("database is locked");

      // ...and the element that does carry it must not be hidden by the
      // stylesheet, which is the exact trap the previous surface fell into.
      const classes = [...html.matchAll(/class="([^"]+)"/gu)].flatMap((match) => match[1]!.split(" "));
      const carrying = classes.filter((name) => !offScreenClasses.includes(name));
      expect(carrying).toContain("hi-action-notice");
      for (const name of carrying) {
        expect(isHiddenByStylesheet(name), `${name} is hidden by the stylesheet`).toBe(false);
      }
      // The off-screen classes really are off-screen — otherwise the check above
      // proves nothing.
      expect(isHiddenByStylesheet("hi-live-region")).toBe(true);
    });

    it("announces the failure once, as an alert", () => {
      const html = renderToStaticMarkup(createElement(HistoryNoticeSurface, {
        notice: historyFailureNotice(new Error("database is locked"), "fallback"),
        onDismiss: () => undefined,
      }));

      expect(html).toContain('role="alert"');
      // Assistive technology would otherwise hear it from both the alert and
      // the polite region.
      expect(html.match(/database is locked/gu)).toHaveLength(1);
    });

    it("offers a way to dismiss the failure", () => {
      const html = renderToStaticMarkup(createElement(HistoryNoticeSurface, {
        notice: historyFailureNotice(new Error("database is locked"), "fallback"),
        onDismiss: () => undefined,
      }));

      expect(html).toContain("Dismiss");
    });

    it("leaves successes in the polite region rather than adding a banner", () => {
      const html = renderToStaticMarkup(createElement(HistoryNoticeSurface, {
        notice: historySuccessNotice("Transcript deleted."),
        onDismiss: () => undefined,
      }));

      // The deleted row disappearing is the visible confirmation; a card for
      // every successful copy would be noise.
      expect(html).not.toContain('role="alert"');
      const liveRegion = html.slice(html.indexOf('class="hi-live-region"'));
      expect(liveRegion).toContain("Transcript deleted.");
    });

    it("renders nothing at all when no action has run", () => {
      const html = renderToStaticMarkup(createElement(HistoryNoticeSurface, {
        notice: null,
        onDismiss: () => undefined,
      }));

      expect(html).not.toContain('role="alert"');
      expect(html).toContain('class="hi-live-region"');
    });

    it("still keeps machine paths out of the now-visible failure text", () => {
      // The message became visible; the redaction that made it safe to show
      // has to hold on this path too.
      expect(historyFailureNotice(
        new Error("EPERM: failed to export C:\\Users\\Alice\\Documents\\history.json"),
        "History could not be exported.",
      )).toEqual({ message: "History could not be exported.", tone: "error" });
      expect(historySuccessNotice("History exported locally."))
        .toEqual({ message: "History exported locally.", tone: "success" });
    });

    it("does not show a stale banner on the initial screen", () => {
      const html = renderToStaticMarkup(createElement(HistoryScreen));

      expect(html).not.toContain('role="alert"');
      expect(html).not.toContain("hi-action-notice");
      // The polite region is still mounted, so an announcement has somewhere to
      // land without remounting the element.
      expect(html).toContain('class="hi-live-region"');
    });
  });

  it("identifies category percentages as a share of dictated words", () => {
    const html = renderToStaticMarkup(createElement(CategoryList, {
      categories: [{
        key: "browser",
        label: "Browsing",
        count: 2,
        words: 9,
        percent: 75,
      }],
    }));

    expect(html).toContain('role="list" aria-label="App categories by share of dictated words"');
    expect(html).toContain("Share of dictated words: ");
    expect(html).toContain("75%");
  });

  it("keeps row actions visible to keyboard and non-hover users and lets the period controls wrap", () => {
    expect(insightsCss).toContain(".hi-overflow--row summary:focus-visible");
    expect(insightsCss).toMatch(/@media \(hover: none\)[\s\S]*\.hi-overflow--row summary \{ opacity: 1; \}/);
    expect(insightsCss).toMatch(/\.hi-period-row \{[^}]*flex-wrap: wrap;/);
    expect(insightsCss).toMatch(/\.hi-overflow--row \.hi-overflow-menu \{[^}]*bottom: calc\(100% \+ 6px\);/);
  });

  /*
   * `activityBarHeightPercent` is only honest if the percentage resolves against
   * a box that is the same height for every column. It did not: the column was a
   * flex column, the bar asked for a percentage of the whole 215px column, and
   * any bar tall enough that bar + 27px label exceeded 215px was cut down by
   * flex-shrink instead. Measured in Chromium at both settings sizes, a 65% day
   * drew 139.75px against the 100% day's 190.30px — 73% as tall, not 65% — and
   * that column's date label was squeezed from 27px to 24.7px. With the plot
   * area on its own definite grid row every ratio is now exact to 0.01%.
   */
  it("gives the bars a plot area that cannot shrink, so bar height stays linear in the data", () => {
    const rule = (selector: string): string => {
      const start = insightsCss.indexOf(`${selector} {`);
      expect(start, `missing stylesheet rule: ${selector}`).toBeGreaterThanOrEqual(0);
      return insightsCss.slice(start, insightsCss.indexOf("}", start));
    };

    const column = rule(".hi-chart-column");
    expect(column).toContain("display: grid");
    expect(column).toContain("grid-template-rows: minmax(0, 1fr) var(--hi-chart-label-height)");
    // A flex column is exactly what let the label steal height from the bar.
    expect(column).not.toContain("display: flex");

    // One token drives the plot area, the gridline area, and the label box, so
    // the top gridline is the maximum and the baseline is zero.
    expect(rule(".hi-chart")).toContain("--hi-chart-label-height: 27px");
    expect(rule(".hi-chart-grid")).toContain("inset: 0 0 var(--hi-chart-label-height)");
    expect(rule(".hi-chart-label")).toContain("height: var(--hi-chart-label-height)");
    expect(rule(".hi-chart-column > i")).not.toMatch(/(^|[;{\s])height:/);

    // The row assignment above only holds while the column has exactly these
    // two in-flow children, in this order, after the out-of-flow tooltip.
    const html = renderToStaticMarkup(createElement(ActivityChart, {
      points: [{ key: "2026-07-22", words: 4, label: "W", fullLabel: "Jul 22" }],
    }));
    const renderedColumn = html.slice(html.indexOf('class="hi-chart-column"'));
    expect(renderedColumn).toMatch(/<i [^>]*><\/i><span class="hi-chart-label"/);
    // The bar and the label, and nothing else, occupy the two rows.
    expect(renderedColumn.match(/<(?:i|span|div|p|strong|small)\b/gu)?.length).toBe(
      1 /* tooltip */ + 2 /* tooltip strong + small */ + 1 /* bar */ + 1 /* label */,
    );
  });
});
