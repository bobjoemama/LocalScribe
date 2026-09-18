import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASR_MAX_CONTEXT_CHARS } from "../src/shared/audioProtocol";
import {
  buildDictionaryAsrContext,
  dictionaryAsrContextForCapabilities,
} from "../src/shared/dictionaryContext";

describe("buildDictionaryAsrContext", () => {
  it("serializes the complete dictionary when it fits, highest priority last", () => {
    expect(buildDictionaryAsrContext([
      { phrase: "q when", replacement: "Qwen", createdAt: 1 },
      { phrase: "local scribe", replacement: "LocalScribe", createdAt: 2 },
    ])).toBe("q when=Qwen, local scribe=LocalScribe");
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

describe("dictionaryAsrContextForCapabilities", () => {
  const entries = [{ phrase: "local scribe", replacement: "LocalScribe", createdAt: 1 }];

  it("supplies a recognizer hint only to models that explicitly support one", () => {
    expect(dictionaryAsrContextForCapabilities(entries, { promptContext: true }))
      .toBe("local scribe=LocalScribe");
    expect(dictionaryAsrContextForCapabilities(entries, { promptContext: false })).toBe("");
  });
});

/*
 * Context consumers may retain only the tail of a bounded prompt. Preserve
 * the established lowest-priority-first ordering so the newest entries remain
 * at the end. These tests pin the surviving tail, not just the selection, and
 * do not assume a specific tokenizer or truncation policy for the current model.
 */
describe("dictionary ASR context survives front truncation", () => {
  /** Simulate a consumer retaining the tail, using characters as a token proxy. */
  function keepTail(context: string, chars: number): string {
    return context.slice(-chars);
  }

  const entries = Array.from({ length: 40 }, (_, index) => ({
    phrase: `phrase-${index}`,
    replacement: `Replacement${index}`,
    createdAt: index,
  }));

  it("keeps the newest entries when a consumer drops the front of the prompt", () => {
    const context = buildDictionaryAsrContext(entries);
    const survivors = keepTail(context, 60);

    expect(survivors).toContain("phrase-39=Replacement39");
    expect(survivors).not.toContain("phrase-0=Replacement0");
  });

  it("orders every selected term oldest first so priority rises toward the tail", () => {
    const positions = entries.map((entry) =>
      buildDictionaryAsrContext(entries).indexOf(`${entry.phrase}=${entry.replacement}`),
    );

    expect(positions.every((position) => position >= 0)).toBe(true);
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]!).toBeGreaterThan(positions[index - 1]!);
    }
  });

  it("still drops the oldest entries first when the limit bites", () => {
    const context = buildDictionaryAsrContext(entries, 70);

    expect(context).toContain("phrase-39=Replacement39");
    expect(context).not.toContain("phrase-0=Replacement0");
    expect(context.endsWith("phrase-39=Replacement39")).toBe(true);
  });

  it("preserves the documented priority ordering for bounded recognition context", () => {
    const source = readFileSync("src/shared/dictionaryContext.ts", "utf8");

    expect(source).toContain("highest-priority");
    expect(source).toContain("selected.reverse()");
  });
});
