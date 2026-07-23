import { describe, expect, it } from "vitest";
import { findScratchpadMatches } from "../src/renderer/scratchpad/search";

describe("scratchpad utility search", () => {
  it("finds every non-overlapping match without regard to case", () => {
    expect(findScratchpadMatches("Draft a reply, then polish the REPLY.", "reply")).toEqual([8, 31]);
  });

  it("does not search until the user enters a non-blank term", () => {
    expect(findScratchpadMatches("Private draft", "  ")).toEqual([]);
  });
});
