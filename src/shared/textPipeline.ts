import type { DictionaryEntry, Snippet } from "./contracts";

export interface LocalTextRuleOptions {
  normalizeSpacing?: boolean;
}

const WORD_CHARACTER = "[\\p{L}\\p{N}\\p{M}_]";

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function canonicalRuleKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("und");
}

function replacePhase(
  text: string,
  rules: ReadonlyArray<{ match: string; replacement: string }>,
): string {
  const unique = new Map<string, { match: string; replacement: string }>();
  for (const rule of rules) {
    const match = rule.match.normalize("NFC");
    if (!match) continue;
    const key = canonicalRuleKey(match);
    if (!unique.has(key)) unique.set(key, { match, replacement: rule.replacement });
  }
  const ordered = [...unique.values()].sort((left, right) =>
    right.match.length - left.match.length || left.match.localeCompare(right.match),
  );
  if (ordered.length === 0) return text;

  const alternatives = ordered.map(({ match }) => {
    const escaped = escapeRegularExpression(match);
    const startsWithWord = /^[\p{L}\p{N}\p{M}_]/u.test(match);
    const endsWithWord = /[\p{L}\p{N}\p{M}_]$/u.test(match);
    return `${startsWithWord ? `(?<!${WORD_CHARACTER})` : ""}${escaped}${endsWithWord ? `(?!${WORD_CHARACTER})` : ""}`;
  });
  const replacements = new Map(
    ordered.map((rule) => [canonicalRuleKey(rule.match), rule.replacement]),
  );
  return text.normalize("NFC").replace(
    new RegExp(alternatives.map((pattern) => `(?:${pattern})`).join("|"), "giu"),
    (matched) => replacements.get(canonicalRuleKey(matched)) ?? matched,
  );
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
  output = replacePhase(
    output,
    dictionary.map((entry) => ({ match: entry.phrase, replacement: entry.replacement })),
  );
  output = replacePhase(
    output,
    snippets.map((snippet) => ({ match: snippet.trigger, replacement: snippet.expansion })),
  );
  return output;
}
