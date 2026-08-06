import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASR_MAX_CONTEXT_CHARS } from "../src/shared/audioProtocol";
import { buildDictionaryAsrContext } from "../src/shared/dictionaryContext";

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

/*
 * mlx-whisper truncates `initial_prompt` from the front — it keeps only
 * `prompt_tokens[-(n_ctx // 2 - 1):]`, i.e. the last 223 tokens for large-v3,
 * where the protocol lets this builder emit 4,000 characters. Emitting
 * newest-first therefore fed Whisper a prompt whose surviving tail was the
 * *oldest* entries, silently inverting the priority the builder computes. These
 * tests pin the surviving tail, not just the selection.
 */
describe("dictionary ASR context survives front truncation", () => {
  /** What Whisper actually keeps: the tail. Character count stands in for tokens. */
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

  it("documents the Whisper truncation that makes the ordering load-bearing", () => {
    const source = readFileSync("src/shared/dictionaryContext.ts", "utf8");

    expect(source).toContain("prompt_tokens[-(n_ctx // 2 - 1):]");
    expect(source).toContain("selected.reverse()");
  });
});
