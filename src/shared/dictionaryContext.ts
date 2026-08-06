import { ASR_MAX_CONTEXT_CHARS } from "./audioProtocol";

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
 * terms sit at the end of the string. That ordering exists because the Whisper
 * backend truncates this hint again, from the front: mlx-whisper feeds it as
 * `initial_prompt`, and `DecodingTask._get_initial_tokens` keeps only
 * `prompt_tokens[-(n_ctx // 2 - 1):]` — 223 tokens for large-v3, far less than
 * the 4,000 characters this builder is allowed to emit. Emitting newest-first
 * meant Whisper's own truncation discarded precisely the newest entries this
 * function had just gone out of its way to prioritise. Emitting newest-last
 * makes that truncation drop the lowest-priority terms instead.
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
