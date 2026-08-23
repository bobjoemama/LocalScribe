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

  it("does not reduce path-like hostile input to a basename", () => {
    expect(applicationIdsMatch("Slack.app", "/Applications/Slack.app")).toBe(false);
    expect(applicationIdsMatch("Slack.app", "Volume:\\Apps\\Slack.app")).toBe(false);
    expect(applicationIdsMatch("/Applications/Slack.app", "\\Applications\\SLACK.APP")).toBe(true);
  });
});
