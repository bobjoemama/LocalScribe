import type { FillerRemovalOptions, TextTransformResult } from "./types";
import {
  cleanupTokenArtifacts,
  renderTokens,
  tokenizeText,
  wordSequenceAt,
  type TextToken,
} from "./tokens";

const CONSERVATIVE_FILLERS = ["um", "uh", "erm", "hmm"] as const;
const AGGRESSIVE_FILLERS = [
  ...CONSERVATIVE_FILLERS,
  "ah",
  "er",
  "basically",
  "literally",
  "actually",
  "you know",
  "i mean",
  "kind of",
  "sort of",
  "like",
] as const;

interface FillerPhrase {
  words: string[];
}

function makePhrases(mode: "conservative" | "aggressive", custom: readonly string[]): FillerPhrase[] {
  const builtIn = mode === "aggressive" ? AGGRESSIVE_FILLERS : CONSERVATIVE_FILLERS;
  const seen = new Set<string>();
  return [...builtIn, ...custom]
    .map((phrase) => phrase.trim().toLocaleLowerCase("en-US").split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0)
    .filter((words) => {
      const key = words.join(" ");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => right.length - left.length)
    .map((words) => ({ words }));
}

function isProtectedAcronym(token: TextToken | undefined): boolean {
  return token?.kind === "word" && token.value.length > 1 && token.value === token.value.toUpperCase();
}

export function removeFillers(
  text: string,
  options: FillerRemovalOptions = {},
): TextTransformResult {
  const mode = options.mode ?? "conservative";
  if (mode === "off" || text.trim().length === 0) {
    return {
      text:
        options.normalizeWhitespace === false
          ? text
          : text.trim().replace(/[\t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n"),
      stats: { removedFillers: 0, punctuationCommands: 0, paragraphCommands: 0, backtracks: 0 },
    };
  }

  const tokens = tokenizeText(text);
  const phrases = makePhrases(mode, options.customFillers ?? []);
  const output: TextToken[] = [];
  let removedFillers = 0;

  for (let index = 0; index < tokens.length; ) {
    const phrase = phrases.find(({ words }) => wordSequenceAt(tokens, index, words));
    if (!phrase || (phrase.words.length === 1 && isProtectedAcronym(tokens[index]))) {
      output.push(tokens[index]!);
      index += 1;
      continue;
    }

    removedFillers += 1;
    index += phrase.words.length;

    const previous = output.at(-1);
    const next = tokens[index];
    if (previous?.kind === "punctuation" && previous.value === ",") {
      if (!next || next.kind === "break" || (next.kind === "punctuation" && /[.!?]/u.test(next.value))) {
        output.pop();
      }
    } else if (next?.kind === "punctuation" && next.value === ",") {
      index += 1;
    }
  }

  return {
    text: renderTokens(cleanupTokenArtifacts(output), options.normalizeWhitespace !== false),
    stats: { removedFillers, punctuationCommands: 0, paragraphCommands: 0, backtracks: 0 },
  };
}
