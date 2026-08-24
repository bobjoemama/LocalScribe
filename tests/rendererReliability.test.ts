import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sharedCss = readFileSync("src/renderer/styles.css", "utf8");
const historyCss = readFileSync("src/renderer/settings/screens/history-insights.css", "utf8");
const styleCss = readFileSync("src/renderer/settings/screens/style-settings.css", "utf8");
const libraryCss = readFileSync("src/renderer/settings/screens/library-notes.css", "utf8");
const scratchpadCss = readFileSync("src/renderer/scratchpad/scratchpad-window.css", "utf8");
const settingsSource = readFileSync("src/renderer/settings/screens/StyleSettings.tsx", "utf8");
const librarySource = readFileSync("src/renderer/settings/screens/LibraryNotes.tsx", "utf8");

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

describe("renderer contrast contract", () => {
  it("keeps essential normal text at or above WCAG AA", () => {
    const pairs = [
      ["#476d64", "#eef6f1", sharedCss],
      ["#68635d", "#ffffff", historyCss],
      ["#3f6e63", "#e6f0ec", historyCss],
      ["#68625b", "#fbfaf8", styleCss],
      ["#68625b", "#f8f6f3", libraryCss],
      ["#666660", "#f6f6f5", scratchpadCss],
    ] as const;
    for (const [foreground, background, stylesheet] of pairs) {
      expect(stylesheet).toContain(foreground);
      expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps enabled custom control boundaries above the 3:1 non-text floor", () => {
    for (const foreground of ["#77716a", "#76716a"]) {
      expect(styleCss).toContain(foreground);
      expect(contrast(foreground, "#ffffff")).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("renderer operation latches", () => {
  it("uses one synchronous latch for every user-started model operation", () => {
    expect(settingsSource).not.toContain("modelApplyInFlight");
    expect(settingsSource).not.toContain("modelLibraryActionInFlight");
    expect(settingsSource.match(/if \(modelOperationInFlight\.current\) return;/g)).toHaveLength(4);
    expect(settingsSource).toContain("if (!settings || modelOperationInFlight.current) return;");
    expect(settingsSource.match(/modelOperationInFlight\.current = true;/g)).toHaveLength(5);
  });

  it("latches ordinary and cleanup saves before awaiting persistence", () => {
    expect(settingsSource).toContain("if (!settings || settingsSaveInFlight.current) return;");
    expect(settingsSource).toContain("settingsSaveInFlight.current = true;");
    expect(settingsSource).toContain("if (!settings || cleanupSaveInFlight.current) return;");
    expect(settingsSource).toContain("cleanupSaveInFlight.current = true;");
  });
});

describe("library modal and load lifecycle", () => {
  it("accepts only the latest mounted list result", () => {
    expect(librarySource.match(/sequence === loadSequence\.current/g)).toHaveLength(6);
    expect(librarySource.match(/loadSequence\.current \+= 1/g)).toHaveLength(2);
  });

  it("makes the page inert behind each add dialog and blocks dismissal while saving", () => {
    expect(librarySource.match(/<div inert=\{showAdd\}>/g)).toHaveLength(2);
    expect(librarySource.match(/if \(!saveInFlight\.current\) onClose\(\);/g)).toHaveLength(2);
    expect(librarySource.match(/busy=\{saving\}/g)).toHaveLength(2);
  });
});

describe("confirmed renderer cleanup", () => {
  it("keeps full read-only values visible and removes dead selectors", () => {
    const readOnlyRule = styleCss.slice(
      styleCss.indexOf(".ls-readonly-value {"),
      styleCss.indexOf("}", styleCss.indexOf(".ls-readonly-value {")),
    );
    expect(readOnlyRule).toContain("overflow-wrap: anywhere");
    expect(readOnlyRule).toContain("white-space: normal");
    expect(readOnlyRule).not.toContain("text-overflow: ellipsis");

    for (const deadSelector of [
      ".screen-page",
      ".screen-heading",
      ".danger-button",
      ".ls-rule-input",
      ".ls-model-row",
      ".ls-model-dot",
      ".ls-model-unknown-actions",
    ]) {
      expect(`${sharedCss}\n${styleCss}`).not.toContain(deadSelector);
    }
  });
});
