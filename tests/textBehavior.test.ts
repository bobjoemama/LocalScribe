import { describe, expect, it } from "vitest";
import {
  CLEANUP_PRESETS,
  applySpokenCommands,
  cleanupOptionsForPreset,
  removeFillers,
  resolveAppCleanupOptions,
  transformDictation,
  type AppCleanupProfile,
} from "../src/shared/text";

describe("removeFillers", () => {
  it("removes conservative standalone fillers without touching substrings", () => {
    const result = removeFillers("Um, the umbrella, uh, is over there.");
    expect(result.text).toBe("the umbrella, is over there.");
    expect(result.stats.removedFillers).toBe(2);
  });

  it("removes filler phrases only in aggressive mode", () => {
    expect(removeFillers("I mean this is actually ready").text).toBe(
      "I mean this is actually ready",
    );
    expect(removeFillers("I mean this is actually ready", { mode: "aggressive" }).text).toBe(
      "this is ready",
    );
  });

  it("supports deterministic custom multi-word fillers", () => {
    const result = removeFillers("For what it is worth, ship it", {
      customFillers: ["for what it is worth"],
    });
    expect(result).toMatchObject({
      text: "ship it",
      stats: { removedFillers: 1 },
    });
  });

  it("deduplicates custom fillers before counting removals", () => {
    const result = removeFillers("um um done", { customFillers: ["UM", "um"] });
    expect(result.text).toBe("done");
    expect(result.stats.removedFillers).toBe(2);
  });

  it("protects uppercase acronyms", () => {
    expect(removeFillers("Go to the ER and say UM").text).toBe("Go to the ER and say UM");
  });

  it("can be fully disabled without altering bytes", () => {
    const input = "  um   keep\n\n\n this  ";
    expect(removeFillers(input, { mode: "off", normalizeWhitespace: false }).text).toBe(input);
  });

  it("handles a filler-only input", () => {
    expect(removeFillers("um, uh").text).toBe("");
  });
});

describe("applySpokenCommands punctuation and paragraphs", () => {
  it("converts common punctuation commands case-insensitively", () => {
    const result = applySpokenCommands(
      "Hello COMMA world exclamation point Are you there question mark",
    );
    expect(result.text).toBe("Hello, world! Are you there?");
    expect(result.stats.punctuationCommands).toBe(3);
  });

  it("supports colons, semicolons, dashes, hyphens, and slashes", () => {
    expect(
      applySpokenCommands(
        "Status colon ready semicolon ship dash today period well hyphen known and or slash maybe",
      ).text,
    ).toBe("Status: ready; ship \u2014 today. well-known and or/maybe");
  });

  it("supports paired quotes, parentheses, and brackets", () => {
    expect(
      applySpokenCommands(
        "open quote hello close quote open parenthesis private close parenthesis open bracket local close bracket",
      ).text,
    ).toBe("\u201chello\u201d (private) [local]");
  });

  it("creates line and paragraph breaks", () => {
    const result = applySpokenCommands("one new line two new paragraph three");
    expect(result.text).toBe("one\ntwo\n\nthree");
    expect(result.stats.paragraphCommands).toBe(2);
  });

  it("does not match commands inside larger words", () => {
    expect(applySpokenCommands("a periodic comma-shaped object").text).toBe(
      "a periodic comma-shaped object",
    );
  });

  it("can disable punctuation independently from paragraphs", () => {
    expect(
      applySpokenCommands("hello comma new paragraph world", {
        punctuationCommands: false,
      }).text,
    ).toBe("hello comma\n\nworld");
  });

  it("can disable paragraphs independently from punctuation", () => {
    expect(
      applySpokenCommands("hello comma new paragraph world", {
        paragraphCommands: false,
      }).text,
    ).toBe("hello, new paragraph world");
  });

  it("is byte-preserving when every command and normalization are disabled", () => {
    const input = "  hello comma\n scratch that  ";
    expect(
      applySpokenCommands(input, {
        punctuationCommands: false,
        paragraphCommands: false,
        scratchCommands: false,
        normalizeWhitespace: false,
      }).text,
    ).toBe(input);
  });
});

describe("applySpokenCommands backtracking", () => {
  it("uses scratch-that to replace the most recent word", () => {
    const result = applySpokenCommands("Meet at four scratch that five");
    expect(result.text).toBe("Meet at five");
    expect(result.stats.backtracks).toBe(1);
  });

  it("supports repeated word backtracking", () => {
    expect(applySpokenCommands("one two three scratch that scratch that four").text).toBe(
      "one four",
    );
  });

  it("makes scratch-that remove the prior completed sentence", () => {
    expect(
      applySpokenCommands(
        "First sentence period Wrong sentence period scratch that Correct sentence period",
      ).text,
    ).toBe("First sentence. Correct sentence.");
  });

  it("recognizes never-mind as an adaptive backtrack", () => {
    expect(applySpokenCommands("Meet at four never mind five").text).toBe("Meet at five");
  });

  it("backtracks a completed sentence ending in a closing quote", () => {
    expect(
      applySpokenCommands(
        "Keep this period open quote Remove this period close quote scratch that Continue",
      ).text,
    ).toBe("Keep this. Continue");
  });

  it("supports an explicit sentence scope without trailing punctuation", () => {
    expect(
      applySpokenCommands(
        "Keep this period remove all these words scratch last sentence Next sentence",
      ).text,
    ).toBe("Keep this. Next sentence");
  });

  it("supports an explicit paragraph scope and preserves its structural position", () => {
    expect(
      applySpokenCommands(
        "First paragraph new paragraph Remove this scratch last paragraph Replacement paragraph",
      ).text,
    ).toBe("First paragraph\n\nReplacement paragraph");
  });

  it("is safe when there is nothing to backtrack", () => {
    expect(applySpokenCommands("scratch that hello").text).toBe("hello");
  });

  it("leaves scratch phrases literal when disabled", () => {
    expect(
      applySpokenCommands("four scratch that five", { scratchCommands: false }).text,
    ).toBe("four scratch that five");
  });
});

describe("cleanup profiles", () => {
  it("returns isolated copies so callers cannot mutate a preset", () => {
    const first = cleanupOptionsForPreset("balanced");
    const second = cleanupOptionsForPreset("balanced");
    expect(first).not.toBe(second);
    expect(first.customFillers).not.toBe(second.customFillers);
    expect(first).toEqual(CLEANUP_PRESETS.balanced);
  });

  it("resolves an app profile case-insensitively with typed overrides", () => {
    const profiles: AppCleanupProfile[] = [
      {
        appId: "com.apple.TextEdit",
        preset: "document",
        overrides: { fillerMode: "aggressive", customFillers: ["to be honest"] },
      },
    ];
    expect(resolveAppCleanupOptions("COM.APPLE.TEXTEDIT", profiles)).toMatchObject({
      fillerMode: "aggressive",
      terminalPunctuation: "ensure",
      customFillers: ["to be honest"],
    });
  });

  it("uses the requested fallback for unknown and missing apps", () => {
    expect(resolveAppCleanupOptions("com.unknown", [], "verbatim")).toEqual(
      CLEANUP_PRESETS.verbatim,
    );
    expect(resolveAppCleanupOptions(null, [], "document")).toEqual(CLEANUP_PRESETS.document);
  });

  it("uses the first matching profile deterministically", () => {
    const profiles: AppCleanupProfile[] = [
      { appId: "com.example.app", preset: "document" },
      { appId: "com.example.app", preset: "verbatim" },
    ];
    expect(resolveAppCleanupOptions("com.example.app", profiles).terminalPunctuation).toBe(
      "ensure",
    );
  });
});

describe("transformDictation", () => {
  it("runs filler removal before spoken corrections and formatting", () => {
    const result = transformDictation(
      "um meet at four scratch that five comma please new paragraph uh bring notes period",
    );
    expect(result.text).toBe("Meet at five, please\n\nBring notes.");
    expect(result.stats).toEqual({
      removedFillers: 2,
      punctuationCommands: 2,
      paragraphCommands: 1,
      backtracks: 1,
    });
  });

  it("ensures terminal punctuation for document profiles", () => {
    expect(transformDictation("ship the document", cleanupOptionsForPreset("document")).text).toBe(
      "Ship the document.",
    );
  });

  it("does not duplicate terminal punctuation", () => {
    expect(
      transformDictation("is it ready question mark", cleanupOptionsForPreset("document")).text,
    ).toBe("Is it ready?");
  });

  it("can strip terminal punctuation without removing internal punctuation", () => {
    expect(
      transformDictation("First sentence. Second sentence!", {
        fillerMode: "off",
        punctuationCommands: false,
        paragraphCommands: false,
        scratchCommands: false,
        terminalPunctuation: "strip",
      }).text,
    ).toBe("First sentence. Second sentence");
  });

  it("capitalizes Unicode sentence starts and paragraph starts", () => {
    expect(transformDictation("\u00e9lan period \u00fcber new paragraph \u00f1and\u00fa").text).toBe(
      "\u00c9lan. \u00dcber\n\n\u00d1and\u00fa",
    );
  });

  it("honors the byte-preserving verbatim preset", () => {
    const input = "  um comma scratch that\n\n raw  ";
    expect(transformDictation(input, cleanupOptionsForPreset("verbatim")).text).toBe(input);
  });

  it("is deterministic across repeated runs", () => {
    const input = "uh alpha comma beta scratch that gamma period";
    const options = cleanupOptionsForPreset("document");
    expect(transformDictation(input, options)).toEqual(transformDictation(input, options));
  });

  it("handles empty input", () => {
    expect(transformDictation("")).toEqual({
      text: "",
      stats: {
        removedFillers: 0,
        punctuationCommands: 0,
        paragraphCommands: 0,
        backtracks: 0,
      },
    });
  });
});

/*
 * The tokenizer treated `.`, `:` and `@` as separators, so an alphanumeric run
 * containing one was split; the renderer then glued the mark to the left and
 * put a space before what followed, and sentence capitalization uppercased it.
 * Every dictated price, decimal, clock time, email address and domain came out
 * corrupted — on the default preset, silently, in the text pasted into the
 * user's target app. 852 tests passed over it because no test in the suite
 * dictated a digit, a currency sign, an email or a URL.
 *
 * The options below are exactly what src/main.ts:1325-1333 passes for the
 * default settings.
 */
describe("text that contains a period, colon, or at-sign", () => {
  const DEFAULTS = {
    fillerMode: "conservative" as const,
    punctuationCommands: true,
    paragraphCommands: true,
    scratchCommands: true,
    capitalizeSentences: true,
    terminalPunctuation: "ensure" as const,
    normalizeWhitespace: true,
  };

  const render = (input: string): string => transformDictation(input, DEFAULTS).text;

  it.each([
    ["a price", "The price is $4.50 today.", "The price is $4.50 today."],
    ["a decimal", "Version 3.14 shipped.", "Version 3.14 shipped."],
    ["a clock time", "Meet at 3:30 today.", "Meet at 3:30 today."],
    ["a thousands separator", "It cost 1,000 dollars.", "It cost 1,000 dollars."],
    ["an email address", "Send it to jane@example.com now.", "Send it to jane@example.com now."],
    ["a domain", "Check github.com for it.", "Check github.com for it."],
    ["an abbreviation", "Meet at 3:30 p.m. sharp.", "Meet at 3:30 p.m. sharp."],
    ["a version string", "Upgrade to 2.4.1 first.", "Upgrade to 2.4.1 first."],
  ])("passes %s through unchanged", (_label, input, expected) => {
    expect(render(input)).toBe(expected);
  });

  it("still capitalizes a real sentence boundary", () => {
    // The repair must not turn every period into an interior one.
    expect(render("this is a sentence. another one here.")).toBe(
      "This is a sentence. Another one here.",
    );
    expect(render("done! next thing.")).toBe("Done! Next thing.");
    expect(render("ready? go now.")).toBe("Ready? Go now.");
  });

  it("still separates a colon or comma between words", () => {
    // The colon and comma bridges are digit-only precisely so this keeps working.
    expect(render("note:this matters.")).toBe("Note: this matters.");
    expect(render("alpha,beta gamma.")).toBe("Alpha, beta gamma.");
  });

  it("does not pad a straight quotation mark on both sides", () => {
    expect(render('He said "hello there" loudly.')).toBe('He said "hello there" loudly.');
  });

  it.each([
    "Send to jane+work@example.com now.",
    "Send to jane_doe@example.com now.",
    "Send to jane.doe+work_mail@example.co.uk now.",
  ])("preserves email address punctuation: %s", (text) => {
    expect(render(text)).toBe(text);
  });

  it("preserves directional curly quotes without padding their contents", () => {
    expect(render("He said “hello there” loudly.")).toBe("He said “hello there” loudly.");
    expect(render("Use “first” and “second”.")).toBe("Use “first” and “second”.");
  });

  it("does not join spaced arithmetic while preserving email addresses", () => {
    expect(render("The sum is 2 + 3.")).toBe("The sum is 2 + 3.");
  });

  it("keeps a currency sign attached to its amount", () => {
    expect(render("It costs $12 total.")).toBe("It costs $12 total.");
    expect(render("It costs £7.50 total.")).toBe("It costs £7.50 total.");
  });

  it("corrupts nothing when every cleanup is off", () => {
    const verbatim = "Send $4.50 to jane@example.com at 3:30.";
    expect(transformDictation(verbatim, cleanupOptionsForPreset("verbatim")).text).toBe(verbatim);
  });
});

/*
 * The closing-punctuation branch of renderTokens did `output.trimEnd() + value`,
 * which also removed the newline a break token had just written. A dictated
 * bullet list collapsed onto one line.
 */
describe("spoken line breaks followed by punctuation", () => {
  it("keeps the break when a bullet marker follows it", () => {
    const result = transformDictation(
      "groceries colon new line hyphen milk new line hyphen eggs",
    ).text;

    expect(result.split("\n")).toHaveLength(3);
    expect(result).toContain("milk");
    expect(result).toContain("eggs");
    // The defect signature: everything on one line, joined by the hyphens.
    expect(result).not.toContain("milk-eggs");
  });

  it("keeps a paragraph break that is followed by a comma", () => {
    expect(transformDictation("hello new paragraph comma world").text).toContain("\n\n");
  });

  it("still renders break-then-word correctly", () => {
    expect(transformDictation("one new line two new paragraph three").text)
      .toBe("One\nTwo\n\nThree");
  });
});
