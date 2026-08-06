import { applySpokenCommands } from "./commands";
import { removeFillers } from "./fillers";
import { DEFAULT_CLEANUP_OPTIONS } from "./profiles";
import type { TextCleanupOptions, TextTransformResult } from "./types";

/*
 * Does the `.` at `index` close an abbreviation rather than a sentence?
 *
 * Only the shape is available here, and one shape is unambiguous enough to act
 * on: a single letter preceded by another period \u2014 "p.m.", "e.g.", "U.S.".
 * Treating those as sentence ends is what produced "Meet at 3:30 p.m. Sharp."
 */
function closesAbbreviation(characters: readonly string[], index: number): boolean {
  const letter = characters[index - 1];
  return letter !== undefined && /\p{L}/u.test(letter) && characters[index - 2] === ".";
}

function capitalizeSentences(text: string): string {
  const characters = [...text];
  let atSentenceStart = true;
  return characters
    .map((character, index) => {
      if (atSentenceStart && /\p{L}/u.test(character)) {
        atSentenceStart = false;
        return character.toLocaleUpperCase();
      }
      if (character === "\n") {
        atSentenceStart = true;
        return character;
      }
      if (/[.!?]/u.test(character)) {
        /*
         * A period only ends a sentence when something ends after it. The
         * unconditional version capitalized the letter after every period,
         * including the ones inside a token: "jane@example.com" became
         * "jane@example.Com" and "3:30 p.m. sharp" became "p.M. Sharp".
         */
        const next = characters[index + 1];
        atSentenceStart = (next === undefined || /[\s\u201d"')}\]]/u.test(next))
          && !closesAbbreviation(characters, index);
        return character;
      }
      if (!/\s|[\u201c"'([{]/u.test(character)) atSentenceStart = false;
      return character;
    })
    .join("");
}

function applyTerminalPunctuation(
  text: string,
  mode: TextCleanupOptions["terminalPunctuation"],
): string {
  if (mode === "preserve" || text.length === 0) return text;
  if (mode === "strip") return text.replace(/[.!?]+(?=[\u201d"')}\]]*$)/u, "");
  if (/[.!?][\u201d"')}\]]*$/u.test(text)) return text;
  return `${text}.`;
}

export function transformDictation(
  text: string,
  options: Partial<TextCleanupOptions> = {},
): TextTransformResult {
  const resolved: TextCleanupOptions = {
    ...DEFAULT_CLEANUP_OPTIONS,
    ...options,
    customFillers: [...(options.customFillers ?? DEFAULT_CLEANUP_OPTIONS.customFillers)],
  };
  const fillers = removeFillers(text, {
    mode: resolved.fillerMode,
    customFillers: resolved.customFillers,
    normalizeWhitespace: resolved.normalizeWhitespace,
  });
  const commands = applySpokenCommands(fillers.text, {
    punctuationCommands: resolved.punctuationCommands,
    paragraphCommands: resolved.paragraphCommands,
    scratchCommands: resolved.scratchCommands,
    normalizeWhitespace: resolved.normalizeWhitespace,
  });

  let output = commands.text;
  if (resolved.capitalizeSentences) output = capitalizeSentences(output);
  output = applyTerminalPunctuation(output, resolved.terminalPunctuation);

  return {
    text: output,
    stats: {
      removedFillers: fillers.stats.removedFillers,
      punctuationCommands: commands.stats.punctuationCommands,
      paragraphCommands: commands.stats.paragraphCommands,
      backtracks: commands.stats.backtracks,
    },
  };
}
