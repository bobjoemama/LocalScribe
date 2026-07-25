import { describe, expect, it } from "vitest";
import { MAX_HISTORY_ITEMS, type Transcription } from "../src/shared/contracts";
import {
  appCategory,
  calculateStreak,
  categoryBreakdown,
  filterByRange,
  friendlyAppName,
  rangeLabel,
  recentActivity,
} from "../src/shared/insights";

function transcript(
  text: string,
  sourceAppId: string | null,
  createdAt = new Date(2026, 6, 22, 12).getTime(),
): Transcription {
  return {
    id: crypto.randomUUID(),
    createdAt,
    durationMs: 10_000,
    text,
    language: "en",
    modelId: "test",
    status: "complete",
    sourceAppId,
  };
}

describe("local Insights app attribution", () => {
  it("keeps the captured cmux bundle categorized without embedding a personal display alias", () => {
    expect(appCategory("com.cmuxterm.app.nightly")).toEqual({
      key: "development",
      label: "Development",
    });
    expect(friendlyAppName("com.cmuxterm.app.nightly")).toBe("Cmuxterm");
  });

  it("uses distinct, honest categories for common desktop apps", () => {
    expect(appCategory("com.openai.chat").key).toBe("ai");
    expect(appCategory("com.apple.MobileSMS").key).toBe("personal");
    expect(appCategory("com.tinyspeck.slackmacgap").key).toBe("work");
    expect(appCategory("com.apple.mail").key).toBe("email");
    expect(appCategory("md.obsidian").key).toBe("documents");
    expect(appCategory("com.apple.Safari").key).toBe("browser");
  });

  it("recognizes common Windows executable paths and presents useful app names", () => {
    const cases = [
      ["C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe", "development", "Visual Studio Code"],
      ["C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE", "documents", "Microsoft Word"],
      ["C:\\Windows\\System32\\notepad.exe", "documents", "Notepad"],
      ["C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE", "documents", "Microsoft Excel"],
      ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "browser", "Microsoft Edge"],
      ["C:\\Program Files\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE", "email", "Microsoft Outlook"],
      ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "development", "PowerShell"],
      ["C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal\\WindowsTerminal.exe", "development", "Windows Terminal"],
    ] as const;

    for (const [applicationId, category, name] of cases) {
      expect(appCategory(applicationId).key).toBe(category);
      expect(friendlyAppName(applicationId)).toBe(name);
    }
  });

  it("uses only the Windows executable name and never path folders for attribution", () => {
    expect(friendlyAppName("C:\\Users\\Alice\\app.exe")).toBe("App");
    expect(friendlyAppName("  C:\\Programs\\Code.exe  ")).toBe("Visual Studio Code");
    expect(appCategory("C:\\Users\\openai\\Tools\\paint.exe").key).toBe("other");
    expect(appCategory("C:\\Tools\\Knowledge.exe").key).toBe("other");
    expect(appCategory("C:\\Browsers\\msedge.exe").key).toBe("browser");
  });

  it("derives the recent-history label from the shared history limit", () => {
    expect(rangeLabel("recent")).toBe(`Recent ${MAX_HISTORY_ITEMS}`);
  });

  it("ranks categories by dictated words and retains session counts", () => {
    const breakdown = categoryBreakdown([
      transcript("one two three four", "com.cmuxterm.app.nightly"),
      transcript("five six", "com.cmuxterm.app.nightly"),
      transcript("hello there friend", "com.apple.MobileSMS"),
    ]);

    expect(breakdown).toEqual([
      { key: "development", label: "Development", count: 2, words: 6, percent: 67 },
      { key: "personal", label: "Personal messages", count: 1, words: 3, percent: 33 },
    ]);
  });
});

describe("local Insights activity", () => {
  it("uses local calendar days for range cutoffs instead of fixed 24-hour subtraction", () => {
    const now = new Date(2026, 2, 9, 12).getTime();
    const firstDay = new Date(2026, 2, 3, 0).getTime();
    const beforeFirstDay = new Date(2026, 2, 2, 23, 59).getTime();
    const items = [
      transcript("included", null, firstDay),
      transcript("excluded", null, beforeFirstDay),
    ];

    expect(filterByRange(items, "7d", now).map((item) => item.text)).toEqual(["included"]);
  });

  it("buckets exact word totals for each visible day", () => {
    const now = new Date(2026, 6, 22, 12).getTime();
    const yesterday = new Date(2026, 6, 21, 12).getTime();
    const points = recentActivity([
      transcript("one two", "com.apple.Safari", now),
      transcript("three four five", "com.apple.Safari", yesterday),
    ], 7, now);

    expect(points.at(-1)?.words).toBe(2);
    expect(points.at(-2)?.words).toBe(3);
    expect(points.reduce((sum, point) => sum + point.words, 0)).toBe(5);
  });

  it("calculates a streak through today or yesterday", () => {
    const now = new Date(2026, 6, 22, 12).getTime();
    expect(calculateStreak([
      transcript("today", null, new Date(2026, 6, 22, 9).getTime()),
      transcript("yesterday", null, new Date(2026, 6, 21, 9).getTime()),
      transcript("two days ago", null, new Date(2026, 6, 20, 9).getTime()),
    ], now)).toBe(3);
  });
});
