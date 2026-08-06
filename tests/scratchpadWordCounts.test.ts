import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { countWords, createWordCountCache } from "../src/renderer/scratchpad/wordCounts";
import { sliceFollowing } from "./support/order";

/*
 * The Scratchpad list shows "<n> words" under every note. Typing one character
 * into one note rebuilt the whole notes array, so the list recomputed the count
 * for every note — over every byte of every body — on every keystroke. Measured
 * per keystroke before the cache (scratchpad/bench-scratchpad.mjs):
 *
 *     50 notes x  20 KB    1.96 ms
 *     20 notes x 200 KB    8.23 ms
 *      5 notes x   1 MB   10.90 ms
 *
 * The counter is injectable, so these assert on *how many bodies get counted*
 * rather than on elapsed time.
 */

interface Note { id: string; title: string; body: string }

function note(id: string, body: string): Note {
  return { id, title: `Note ${id}`, body };
}

function countingCache() {
  const counted: string[] = [];
  const lookup = createWordCountCache((body) => {
    counted.push(body);
    return countWords(body);
  });
  return { lookup, counted };
}

describe("countWords", () => {
  it.each([
    ["", 0],
    ["   ", 0],
    ["\n\t ", 0],
    ["one", 1],
    ["  one  ", 1],
    ["a b", 2],
    ["a\nb\tc", 3],
    ["  　x　  ", 1],
    ["\u{1F600} \u{1F600}", 2],
  ] as const)("counts %j as %i", (body, expected) => {
    expect(countWords(body)).toBe(expected);
  });
});

describe("the note word-count cache", () => {
  it("counts each note once", () => {
    const { lookup, counted } = countingCache();
    const notes = [note("a", "one two"), note("b", "three")];

    expect(notes.map(lookup)).toEqual([2, 1]);
    expect(counted).toHaveLength(2);
  });

  it("does not recount a note it has already seen", () => {
    const { lookup, counted } = countingCache();
    const first = note("a", "one two three");

    expect(lookup(first)).toBe(3);
    expect(lookup(first)).toBe(3);
    expect(lookup(first)).toBe(3);
    expect(counted).toEqual(["one two three"]);
  });

  /*
   * The keystroke itself: `updateActiveBody` maps over the notes and spreads a
   * new object for the edited note only, so every other note keeps its identity
   * through the rebuild. That is what makes the cache worth having.
   */
  it("recounts only the note that was edited", () => {
    const { lookup, counted } = countingCache();
    const notes = [note("a", "alpha"), note("b", "beta gamma"), note("c", "delta")];
    notes.forEach(lookup);
    counted.length = 0;

    const rebuilt = notes.map((n) => (n.id === "b" ? { ...n, body: "beta gamma delta" } : n));

    expect(rebuilt.map(lookup)).toEqual([1, 3, 1]);
    expect(counted).toEqual(["beta gamma delta"]);
  });

  it("costs nothing when a rebuild changed no bodies at all", () => {
    const { lookup, counted } = countingCache();
    const notes = [note("a", "alpha"), note("b", "beta")];
    notes.forEach(lookup);
    counted.length = 0;

    // Re-sorting or re-filtering produces a new array of the same objects.
    [...notes].reverse().forEach(lookup);

    expect(counted).toEqual([]);
  });

  /*
   * Identity alone would be a footgun: nothing in the type system stops a note
   * from being mutated in place, and a stale count under a note the user just
   * edited is worse than a slow one.
   */
  it("recounts a note whose body was mutated in place", () => {
    const { lookup, counted } = countingCache();
    const live = note("a", "one");

    expect(lookup(live)).toBe(1);
    live.body = "one two three four";

    expect(lookup(live)).toBe(4);
    expect(counted).toEqual(["one", "one two three four"]);
  });

  it("keeps counts separate for notes with identical bodies", () => {
    const { lookup } = countingCache();
    const a = note("a", "same words here");
    const b = note("b", "same words here");

    expect(lookup(a)).toBe(3);
    expect(lookup(b)).toBe(3);
    a.body = "shorter";
    expect(lookup(a)).toBe(1);
    expect(lookup(b)).toBe(3);
  });

  it("holds no strong reference to a deleted note", () => {
    // A Map keyed by id or by body would keep every note the window has ever
    // shown — and its text — alive for the lifetime of the window.
    const source = readFileSync("src/renderer/scratchpad/wordCounts.ts", "utf8");
    expect(source).toContain("new WeakMap<");
    expect(source).not.toContain("new Map<");
  });
});

describe("the Scratchpad window uses the cache", () => {
  const component = readFileSync("src/renderer/scratchpad/ScratchpadWindow.tsx", "utf8");

  it("keeps one cache across renders instead of rebuilding it", () => {
    // A cache recreated on each render would never hit.
    expect(component).toContain("useRef(createWordCountCache()).current");
  });

  it("counts through the cache everywhere it shows a count", () => {
    expect(component).toContain("const noteWordCount = wordCountFor(note);");
    expect(component).toContain("const activeWordCount = activeNote ? wordCountFor(activeNote) : 0;");
    // The uncached helper must be gone, not merely unused in one place.
    expect(component).not.toMatch(/\bwordCount\(/u);
  });

  it("still filters the list through the shared matcher", () => {
    const memo = sliceFollowing(component, "const filteredNotes = useMemo(", "\n");
    expect(memo).toContain("scratchpadNoteMatches(note, query)");
  });
});
