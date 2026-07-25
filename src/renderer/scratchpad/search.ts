import type { ScratchpadNote } from "../../shared/contracts";

function escapedSearchPattern(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function findScratchpadMatches(text: string, query: string): number[] {
  const needle = query.trim();
  if (!needle) return [];

  const pattern = new RegExp(escapedSearchPattern(needle), "giu");
  return Array.from(text.matchAll(pattern), (match) => match.index);
}

export function scratchpadNoteMatches(note: Pick<ScratchpadNote, "title" | "body">, query: string): boolean {
  return !query.trim()
    || findScratchpadMatches(note.title, query).length > 0
    || findScratchpadMatches(note.body, query).length > 0;
}
