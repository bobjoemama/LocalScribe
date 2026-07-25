import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MAX_HISTORY_ITEMS, type Transcription } from "../src/shared/contracts";
import {
  ActivityChart,
  CategoryList,
  HistoryScreen,
  InsightsScreen,
  activityBarHeightPercent,
  createLatestRequestGate,
  historyErrorMessage,
  historySampleLabel,
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

  it("does not double-count a Windows app when only its install path changes", () => {
    const summary = summarizeTranscriptions([
      transcript({ sourceAppId: "C:\\Users\\Alice\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe" }),
      transcript({ sourceAppId: "D:\\Portable\\VS Code\\CODE.EXE" }),
    ]);

    expect(summary.appCount).toBe(1);
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
      new Error("EPERM: failed to export C:\\Users\\Alice\\Documents\\history.json"),
      "History could not be exported.",
    )).toBe("History could not be exported.");
    expect(historyErrorMessage(
      new Error("Clipboard is temporarily unavailable."),
      "Could not copy to the clipboard.",
    )).toBe("Clipboard is temporarily unavailable.");
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
});
