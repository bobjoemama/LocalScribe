import { describe, expect, it } from "vitest";
import { applicationIdsMatch, normalizeApplicationId } from "../src/shared/appIdentity";

describe("application identity normalization", () => {
  it("normalizes case, surrounding whitespace, separators, and trailing slashes", () => {
    expect(normalizeApplicationId("  C:\\Program Files\\Slack\\SLACK.EXE\\ ")).toBe(
      "c:/program files/slack/slack.exe",
    );
    expect(normalizeApplicationId(" COM.APPLE.TextEdit ")).toBe("com.apple.textedit");
  });

  it("matches bundle identifiers case-insensitively", () => {
    expect(applicationIdsMatch("com.apple.TextEdit", "COM.APPLE.TEXTEDIT")).toBe(true);
    expect(applicationIdsMatch("com.apple.TextEdit", "com.apple.Notes")).toBe(false);
  });

  it("matches a configured Windows executable name to its captured full path", () => {
    expect(
      applicationIdsMatch("Slack.exe", "C:\\Users\\Alice\\AppData\\Local\\slack\\SLACK.EXE"),
    ).toBe(true);
    expect(applicationIdsMatch("Teams.exe", "C:\\Apps\\Slack.exe")).toBe(false);
  });
});
