export function findScratchpadMatches(text: string, query: string): number[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];

  const haystack = text.toLocaleLowerCase();
  const matches: number[] = [];
  let from = 0;
  while (from < haystack.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    matches.push(index);
    from = index + needle.length;
  }
  return matches;
}
