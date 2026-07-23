import type { DictionaryEntry, Snippet } from "./contracts";

export interface LocalTextRuleOptions {
  normalizeSpacing?: boolean;
}

const WORD_CHARACTER = "[\\p{L}\\p{N}\\p{M}_]";

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replacePhrase(text: string, phrase: string, replacement: string): string {
  if (!phrase) return text;
  const escaped = escapeRegularExpression(phrase);
  const startsWithWord = /^[\p{L}\p{N}\p{M}_]/u.test(phrase);
  const endsWithWord = /[\p{L}\p{N}\p{M}_]$/u.test(phrase);
  const pattern = `${startsWithWord ? `(?<!${WORD_CHARACTER})` : ""}${escaped}${endsWithWord ? `(?!${WORD_CHARACTER})` : ""}`;
  return text.replace(new RegExp(pattern, "giu"), () => replacement);
}

export function applyLocalTextRules(
  text: string,
  dictionary: Pick<DictionaryEntry, "phrase" | "replacement">[],
  snippets: Pick<Snippet, "trigger" | "expansion">[],
  options: LocalTextRuleOptions = {},
): string {
  let output = options.normalizeSpacing === false
    ? text
    : text.trim().replace(/\s+([,.;!?])/gu, "$1").replace(/ {2,}/gu, " ");
  for (const entry of dictionary) output = replacePhrase(output, entry.phrase, entry.replacement);
  for (const snippet of snippets) output = replacePhrase(output, snippet.trigger, snippet.expansion);
  return output;
}
