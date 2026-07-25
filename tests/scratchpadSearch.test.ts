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
});
