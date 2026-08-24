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
      [{ trigger: "my sign off", expansion: "Best,\nAlice" }],
    );
    expect(result).toBe("Send this to Qwen ASR using Best,\nAlice");
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
        [{ trigger: "my sign off", expansion: "Best,\nAlice" }],
      ),
    ).toBe("Use Best,\nAlice, not my sign office.");
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

  it("uses longest-match-first rules without cascading within a phase", () => {
    expect(applyLocalTextRules(
      "new york and nyc",
      [
        { phrase: "new", replacement: "old" },
        { phrase: "new york", replacement: "NYC" },
        { phrase: "nyc", replacement: "New York City" },
      ],
      [],
    )).toBe("NYC and New York City");
  });

  it("matches canonically equivalent Unicode rules", () => {
    expect(applyLocalTextRules(
      "Send the résumé",
      [{ phrase: "re\u0301sume\u0301", replacement: "CV" }],
      [],
    )).toBe("Send the CV");
  });

  it("does not cascade one snippet expansion into another snippet", () => {
    expect(applyLocalTextRules(
      "Use signoff",
      [],
      [
        { trigger: "signoff", expansion: "my address" },
        { trigger: "my address", expansion: "private@example.invalid" },
      ],
    )).toBe("Use my address");
  });
});
