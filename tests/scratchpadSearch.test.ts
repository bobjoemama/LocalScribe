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
   * Prove the performance property without a wall-clock threshold. A test
   * process can be pre-empted between two performance.now() calls, which made
   * the old 3 ms assertion fail intermittently even though this function had
   * already stopped at its first hit. RegExp.prototype.test delegates through
   * `exec`, so a temporary counting implementation can prove that, after
   * escaping the query, the matcher checks the title once, the body once, and
   * never asks for a second body hit.
   */
  it("stops after the first body match", () => {
    const originalExec = RegExp.prototype.exec;
    const inputs: string[] = [];
    RegExp.prototype.exec = function boundedExec(input: string): RegExpExecArray | null {
      inputs.push(input);
      if (input === "Long") return null;
      if (input === "needle x needle x") {
        if (inputs.filter((value) => value === input).length > 1) {
          throw new Error("matcher scanned beyond the first body hit");
        }
        const match = ["needle"] as RegExpExecArray;
        match.index = 0;
        match.input = input;
        return match;
      }
      return originalExec.call(this, input);
    };

    let matched: boolean;
    try {
      matched = scratchpadNoteMatches({ title: "Long", body: "needle x needle x" }, "needle");
    } finally {
      RegExp.prototype.exec = originalExec;
    }
    expect(matched).toBe(true);
    expect(inputs).toEqual(["needle", "Long", "needle x needle x"]);
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
