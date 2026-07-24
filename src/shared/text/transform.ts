import { applySpokenCommands } from "./commands";
import { removeFillers } from "./fillers";
import { DEFAULT_CLEANUP_OPTIONS } from "./profiles";
import type { TextCleanupOptions, TextTransformResult } from "./types";

function capitalizeSentences(text: string): string {
  let atSentenceStart = true;
  return [...text]
    .map((character) => {
      if (atSentenceStart && /\p{L}/u.test(character)) {
        atSentenceStart = false;
        return character.toLocaleUpperCase();
      }
      if (/[.!?\n]/u.test(character)) atSentenceStart = true;
      else if (!/\s|[\u201c"'([{]/u.test(character)) atSentenceStart = false;
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
