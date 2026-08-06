/*
 * Word counts for the note list, computed once per note version.
 *
 * Every keystroke in the editor calls `updateActiveBody`, which rebuilds the
 * whole `notes` array. The sidebar renders "<n> words" under every note, so a
 * plain `wordCount(note.body)` in that map recomputed the count for *every*
 * note on *every* character typed into *one* of them. Measured on this machine
 * (scratchpad/bench-scratchpad.mjs), per keystroke:
 *
 *     20 notes x   5 KB    0.21 ms
 *     50 notes x  20 KB    1.96 ms
 *     20 notes x 200 KB    8.23 ms   <- past a 60 Hz frame, before React renders
 *      5 notes x   1 MB   10.90 ms
 *
 * A scratchpad that accumulates dictation reaches those sizes by being used.
 *
 * Only the edited note's body can have changed, and `updateActiveBody` rebuilds
 * only that note's object, so identity is exactly the right cache key. The
 * stored body is compared as well so that a note mutated in place — which React
 * state never does, but nothing here can enforce — yields a fresh count rather
 * than a stale one; for an unchanged body that comparison is a pointer check.
 */

/** Unchanged from the original inline helper, including its whitespace rules. */
export function countWords(body: string): number {
  return body.trim() ? body.trim().split(/\s+/u).length : 0;
}

export type WordCountLookup = (note: { body: string }) => number;

export function createWordCountCache(count: (body: string) => number = countWords): WordCountLookup {
  const cache = new WeakMap<object, { body: string; words: number }>();
  return (note) => {
    const cached = cache.get(note);
    if (cached !== undefined && cached.body === note.body) return cached.words;
    const words = count(note.body);
    cache.set(note, { body: note.body, words });
    return words;
  };
}
