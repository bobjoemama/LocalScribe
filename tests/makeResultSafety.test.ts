import { describe, expect, it } from "vitest";
import { assertExpectedMakeResults } from "../scripts/make-result-safety.mts";

describe("Forge make-result fail-closed gate", () => {
  it("rejects non-macOS hosts and wrong macOS architectures", () => {
    expect(() => assertExpectedMakeResults([], "linux")).toThrow(/unsupported/);
    expect(() =>
      assertExpectedMakeResults([
        { platform: "darwin", arch: "x64", artifacts: ["app.zip"] },
      ], "darwin")
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
        { platform: "linux", arch: "x64", artifacts: ["app.zip"] },
      ], "darwin")
    ).toThrow(/unexpected target/);
  });
});
