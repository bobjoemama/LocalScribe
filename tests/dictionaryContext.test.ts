import { describe, expect, it } from "vitest";
import { ASR_MAX_CONTEXT_CHARS } from "../src/shared/audioProtocol";
import { buildDictionaryAsrContext } from "../src/shared/dictionaryContext";

describe("buildDictionaryAsrContext", () => {
  it("serializes the complete dictionary when it fits", () => {
    expect(buildDictionaryAsrContext([
      { phrase: "q when", replacement: "Qwen", createdAt: 1 },
      { phrase: "local scribe", replacement: "LocalScribe", createdAt: 2 },
    ])).toBe("local scribe=LocalScribe, q when=Qwen");
  });

  it("never exceeds the worker limit or emits a partial dictionary entry", () => {
    const entries = Array.from({ length: 20 }, (_, index) => ({
      phrase: `phrase-${index}-${"p".repeat(180)}`,
      replacement: `replacement-${index}-${"r".repeat(180)}`,
      createdAt: index,
    }));
    const context = buildDictionaryAsrContext(entries);

    expect(context.length).toBeLessThanOrEqual(ASR_MAX_CONTEXT_CHARS);
    for (const term of context.split(", ")) {
      expect(entries.some((entry) => `${entry.phrase}=${entry.replacement}` === term)).toBe(true);
    }
  });

  it("prefers newer entries when the complete dictionary does not fit", () => {
    expect(buildDictionaryAsrContext([
      { phrase: "old", replacement: "one", createdAt: 1 },
      { phrase: "new", replacement: "two", createdAt: 2 },
    ], 11)).toBe("new=two");
  });

  it("rejects invalid limits", () => {
    expect(() => buildDictionaryAsrContext([], -1)).toThrow(/non-negative safe integer/u);
  });
});
