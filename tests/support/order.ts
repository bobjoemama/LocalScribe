import { expect } from "vitest";

/*
 * Ordering assertions that cannot pass by absence.
 *
 * Several tests in this suite pinned "A must happen before B" as
 *
 *   expect(source.indexOf(A)).toBeLessThan(source.indexOf(B))
 *
 * which is satisfied whenever A is *missing*, because `indexOf` returns -1 and
 * -1 is less than every real index. An independent audit demonstrated the
 * consequence on three of them: deleting the very call the test exists to
 * protect — a `window.confirm` before a destructive model removal, a
 * `resizePill()` before the pill mode is announced — left the suite green.
 *
 * The same shape appears in tests that assert on a recorded call order rather
 * than on source text, and it fails the same way: an operation that never ran
 * looks like an operation that ran first.
 *
 * Use these helpers instead. They require both markers to be present, and they
 * name which one was missing.
 */

/** Index of `marker`, failing the test if it is absent. */
export function requireIndex(haystack: string, marker: string, label?: string): number {
  const index = haystack.indexOf(marker);
  expect(index, `${label ?? "source"} does not contain ${JSON.stringify(marker)}`)
    .toBeGreaterThanOrEqual(0);
  return index;
}

/**
 * `before` appears, `after` appears, and `before` comes first.
 *
 * Deliberately three assertions rather than one: a deleted marker reports as a
 * deletion instead of as a reordering.
 */
export function expectPrecedes(
  haystack: string,
  before: string,
  after: string,
  label?: string,
): void {
  const first = requireIndex(haystack, before, label);
  const second = requireIndex(haystack, after, label);
  expect(first, `${JSON.stringify(before)} must come before ${JSON.stringify(after)}`)
    .toBeLessThan(second);
}

/** The same guarantee over a recorded sequence of events. */
export function expectHappenedBefore(
  events: readonly string[],
  before: string,
  after: string,
): void {
  expect(events, `${before} never happened`).toContain(before);
  expect(events, `${after} never happened`).toContain(after);
  expect(events.indexOf(before), `${before} must happen before ${after}`)
    .toBeLessThan(events.indexOf(after));
}

/**
 * Slice `source` between two markers, failing if either is missing.
 *
 * The unguarded form — `source.slice(source.indexOf(a), source.indexOf(b))` —
 * silently widens to the rest of the file when `b` is renamed, so every
 * `toContain` on the result can then match unrelated code somewhere else.
 */
export function sliceBetween(
  source: string,
  from: string,
  to: string,
  label?: string,
): string {
  const start = requireIndex(source, from, label);
  const end = requireIndex(source, to, label);
  expect(end, `${JSON.stringify(to)} must come after ${JSON.stringify(from)}`)
    .toBeGreaterThan(start);
  return source.slice(start, end);
}

/**
 * The same, for an end marker that legitimately repeats.
 *
 * `sliceBetween` pins the *first* occurrence of `to` in the whole file, which
 * is right for a unique marker and wrong for `</button>`, `</div>` or `try {`:
 * there the first occurrence is usually some earlier, unrelated one, and the
 * test fails for a reason that has nothing to do with the code under test. This
 * takes the first `to` that follows `from`, and still fails loudly — rather
 * than widening to the rest of the file — when none does.
 */
export function sliceFollowing(
  source: string,
  from: string,
  to: string,
  label?: string,
): string {
  const start = requireIndex(source, from, label);
  const end = source.indexOf(to, start + from.length);
  expect(
    end,
    `${label ?? "source"} has no ${JSON.stringify(to)} after ${JSON.stringify(from)}`,
  ).toBeGreaterThanOrEqual(0);
  return source.slice(start, end);
}
