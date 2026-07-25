import { describe, expect, it } from "vitest";
import { assertExpectedMakeResults } from "../scripts/make-result-safety.mts";

describe("Forge make-result fail-closed gate", () => {
  it("rejects empty and wrong-target Windows results", () => {
    expect(() => assertExpectedMakeResults([], "win32")).toThrow(/no results/);
    expect(() =>
      assertExpectedMakeResults([
        { platform: "win32", arch: "x64", artifacts: [] },
      ], "win32")
    ).toThrow(/empty artifact/);
    expect(() =>
      assertExpectedMakeResults([
        { platform: "win32", arch: "arm64", artifacts: ["app.zip"] },
      ], "win32")
    ).toThrow(/unexpected target/);
  });

  it("accepts multiple nonempty makers only for one exact Mac target", () => {
    expect(() =>
      assertExpectedMakeResults([
        { platform: "darwin", arch: "arm64", artifacts: ["app.dmg"] },
        { platform: "darwin", arch: "arm64", artifacts: ["app.zip"] },
      ], "darwin")
    ).not.toThrow();
    expect(() =>
      assertExpectedMakeResults([
        { platform: "darwin", arch: "arm64", artifacts: ["app.dmg"] },
        { platform: "win32", arch: "x64", artifacts: ["app.zip"] },
      ], "darwin")
    ).toThrow(/unexpected target/);
  });
});
