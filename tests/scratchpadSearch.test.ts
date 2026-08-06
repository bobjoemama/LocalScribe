import { describe, expect, it } from "vitest";
import {
  findScratchpadMatches,
  scratchpadNoteMatches,
} from "../src/renderer/scratchpad/search";

describe("scratchpad utility search", () => {
  it("finds every non-overlapping match without regard to case", () => {
    expect(findScratchpadMatches("Draft a reply, then polish the REPLY.", "reply")).toEqual([8, 31]);
  });

  it("does not search until the user enters a non-blank term", () => {
    expect(findScratchpadMatches("Private draft", "  ")).toEqual([]);
  });

  it("treats search punctuation literally", () => {
    expect(findScratchpadMatches("Use [draft] before draft.", "[draft]")).toEqual([4]);
    expect(findScratchpadMatches("a.b A.B", "a.b")).toEqual([0, 4]);
  });

  it("returns offsets into the original text when Unicode case folding changes length", () => {
    expect(findScratchpadMatches("İx İX", "x")).toEqual([1, 4]);
  });

  it("filters notes by either title or body using the shared matcher", () => {
    const note = { title: "Project plan", body: "Call Ada on Friday" };
    expect(scratchpadNoteMatches(note, "PROJECT")).toBe(true);
    expect(scratchpadNoteMatches(note, "ada")).toBe(true);
    expect(scratchpadNoteMatches(note, "  ")).toBe(true);
    expect(scratchpadNoteMatches(note, "missing")).toBe(false);
  });

  /*
   * `scratchpadNoteMatches` stops at the first hit rather than collecting every
   * match, which is what makes re-filtering on every keystroke cheap. The
   * hazard that rewrite introduces is a `g` flag: a global regex carries
   * `lastIndex` across calls, so the second `test` of the same pattern resumes
   * mid-string and the same note stops matching. These pin the property from
   * the outside, since that is exactly how the bug would show up — the list
   * emptying itself as the user keeps typing.
   */
  it("gives the same answer however many times it is asked", () => {
    const note = { title: "Weekly plan", body: "plan the plan and then plan again" };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(scratchpadNoteMatches(note, "plan"), `attempt ${attempt}`).toBe(true);
    }
  });

  it("matches every note in a list, not just the first", () => {
    const notes = [
      { title: "One", body: "shared word" },
      { title: "Two", body: "shared word" },
      { title: "Three", body: "shared word" },
    ];
    expect(notes.filter((note) => scratchpadNoteMatches(note, "shared"))).toHaveLength(3);
  });

  /*
   * The exact shape a shared global regex fails on, and the reason the two
   * cases above are not enough: a *failed* `test` resets `lastIndex` to 0, so
   * statefulness only bites when a match leaves the index past where the next
   * note's match sits. Here the first title matches at 4, and the second title
   * would then be searched from 8 — past its match at 0 — so the note whose
   * title plainly contains the term drops out of the filtered list.
   */
  it("matches a later note whose hit is earlier than the previous note's", () => {
    const notes = [
      { title: "The plan is set", body: "no mention here" },
      { title: "plan ahead", body: "no mention here" },
    ];
    expect(notes.filter((note) => scratchpadNoteMatches(note, "plan"))).toHaveLength(2);
  });

  it("treats punctuation in the query literally when filtering notes", () => {
    const note = { title: "Use [draft] later", body: "a.b" };
    expect(scratchpadNoteMatches(note, "[draft]")).toBe(true);
    // Unescaped, `a.b` is a pattern and would match `axb`.
    expect(scratchpadNoteMatches({ title: "x", body: "axb" }, "a.b")).toBe(false);
  });

  it("does not throw on a query that is not valid regex syntax", () => {
    // The user types `(` on the way to typing `(draft)`.
    const note = { title: "Notes", body: "nothing here" };
    expect(() => scratchpadNoteMatches(note, "(")).not.toThrow();
    expect(scratchpadNoteMatches({ title: "a (b)", body: "" }, "(")).toBe(true);
  });

  /*
   * The performance property, as a behaviour rather than a claim in a comment.
   * Collecting every match instead of stopping at the first is semantically
   * identical, so nothing else here can see the difference — but on a 4.5 MB
   * body with 500k hits it is 16 ms against 0.003 ms, per note, per keystroke.
   * The bound below is ~1000x the measured cost and ~5x under the collecting
   * version, so it fails on the reversion without being sensitive to load.
   */
  it("answers a heavily-matching body without scanning all of it", () => {
    const note = { title: "Long", body: "needle x ".repeat(500_000) };
    const start = performance.now();
    expect(scratchpadNoteMatches(note, "needle")).toBe(true);
    expect(performance.now() - start).toBeLessThan(3);
  });

  it("still matches a body whose only hit is at the very end", () => {
    // A resumed `lastIndex` would sail past a late match on the second call.
    const note = { title: "Notes", body: `${"filler ".repeat(200)}needle` };
    expect(scratchpadNoteMatches(note, "needle")).toBe(true);
    expect(scratchpadNoteMatches(note, "needle")).toBe(true);
  });

  it("does not read the body when the title already matched", () => {
    let bodyReads = 0;
    const note = {
      title: "Project plan",
      get body() {
        bodyReads += 1;
        return "unrelated";
      },
    };
    expect(scratchpadNoteMatches(note, "project")).toBe(true);
    expect(bodyReads).toBe(0);
  });
});
