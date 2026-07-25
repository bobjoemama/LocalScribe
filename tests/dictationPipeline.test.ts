import { describe, expect, it } from "vitest";
import { transformDictation } from "../src/shared/text";
import { applyLocalTextRules } from "../src/shared/textPipeline";

describe("end-to-end deterministic dictation text pipeline", () => {
  it("applies cleanup, spoken commands, Dictionary, and Snippets in production order", () => {
    const transformed = transformDictation(
      "um send q when asr comma then my sign off",
      {
        fillerMode: "conservative",
        punctuationCommands: true,
        paragraphCommands: true,
        scratchCommands: true,
        capitalizeSentences: true,
        terminalPunctuation: "ensure",
        normalizeWhitespace: true,
      },
    );
    const finalText = applyLocalTextRules(
      transformed.text,
      [{ phrase: "q when asr", replacement: "Qwen3-ASR" }],
      [{ trigger: "my sign off", expansion: "Best,\nAlice" }],
    );

    expect(transformed.stats.removedFillers).toBe(1);
    expect(transformed.stats.punctuationCommands).toBe(1);
    expect(finalText).toBe("Send Qwen3-ASR, then Best,\nAlice.");
  });
});
