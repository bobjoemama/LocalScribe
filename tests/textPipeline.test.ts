import { describe, expect, it } from "vitest";
import { applyLocalTextRules } from "../src/shared/textPipeline";

describe("applyLocalTextRules", () => {
  it("normalizes spacing without changing the wording", () => {
    expect(applyLocalTextRules("  Hello  there , world !  ", [], [])).toBe("Hello there, world!");
  });

  it("applies dictionary terms before snippet expansion", () => {
    const result = applyLocalTextRules(
      "Send this to Q when ASR using my sign off",
      [{ phrase: "Q when ASR", replacement: "Qwen ASR" }],
      [{ trigger: "my sign off", expansion: "Best,\nDevesh" }],
    );
    expect(result).toBe("Send this to Qwen ASR using Best,\nDevesh");
  });

  it("matches dictionary phrases case-insensitively at word boundaries", () => {
    expect(
      applyLocalTextRules(
        "QWEN is not qwenish, but qwen is Qwen.",
        [{ phrase: "qwen", replacement: "Qwen3" }],
        [],
      ),
    ).toBe("Qwen3 is not qwenish, but Qwen3 is Qwen3.");
  });

  it("matches multi-word snippet triggers without consuming longer words", () => {
    expect(
      applyLocalTextRules(
        "Use MY SIGN OFF, not my sign office.",
        [],
        [{ trigger: "my sign off", expansion: "Best,\nDevesh" }],
      ),
    ).toBe("Use Best,\nDevesh, not my sign office.");
  });

  it("handles Unicode word boundaries and replacement dollar signs literally", () => {
    expect(
      applyLocalTextRules(
        "CAFÉ caféine café",
        [{ phrase: "café", replacement: "$5 coffee" }],
        [],
      ),
    ).toBe("$5 coffee caféine $5 coffee");
  });

  it("preserves recognizer whitespace when normalization is disabled", () => {
    const input = "  Hello   there , world !  ";
    expect(applyLocalTextRules(input, [], [], { normalizeSpacing: false })).toBe(input);
  });
});
