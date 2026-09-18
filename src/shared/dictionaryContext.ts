import { ASR_MAX_CONTEXT_CHARS } from "./audioProtocol";
import type { ModelCapabilities } from "./contracts";

interface DictionaryContextEntry {
  phrase: string;
  replacement: string;
  createdAt?: number;
}

/**
 * Produces a bounded recognizer hint without weakening post-transcription
 * dictionary replacement. Newer entries are preferred when the complete
 * dictionary does not fit the worker protocol's context limit.
 *
 * The selected terms are emitted lowest-priority first, so the highest-priority
 * terms sit at the end of the string. Preserve that established ordering for
 * Qwen's bounded recognition context and for existing dictionaries.
 */
export function buildDictionaryAsrContext(
  entries: readonly DictionaryContextEntry[],
  maxChars = ASR_MAX_CONTEXT_CHARS,
): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) {
    throw new Error("Dictionary ASR context limit must be a non-negative safe integer.");
  }

  const prioritized = entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const createdAtDifference = (right.entry.createdAt ?? 0) - (left.entry.createdAt ?? 0);
      return createdAtDifference || left.index - right.index;
    });
  const selected: string[] = [];
  let length = 0;

  for (const { entry } of prioritized) {
    const term = `${entry.phrase}=${entry.replacement}`;
    const addedLength = term.length + (selected.length > 0 ? 2 : 0);
    if (length + addedLength > maxChars) continue;
    selected.push(term);
    length += addedLength;
  }

  return selected.reverse().join(", ");
}

/**
 * Select the recognizer-only representation of Dictionary for a concrete
 * model capability set. Dictionary replacements themselves are deliberately
 * applied later, to every final transcription, by `applyLocalTextRules`.
 *
 * This keeps a model without prompt support (such as Parakeet Unified) from
 * receiving a field it cannot consume while preserving the user's local
 * replacements after recognition.
 */
export function dictionaryAsrContextForCapabilities(
  entries: readonly DictionaryContextEntry[],
  capabilities: Pick<ModelCapabilities, "promptContext">,
): string {
  return capabilities.promptContext ? buildDictionaryAsrContext(entries) : "";
}
