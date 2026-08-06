import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The history list and the activity chart format a timestamp or a number for
 * every row, and both re-render whenever the search field or the range changes.
 * Constructing an Intl formatter costs about 22.6us against 0.45us to reuse one
 * (measured with `new Intl.DateTimeFormat(...).format(...)` in this repo's
 * Node), so building them per row put ~23ms of pure ICU setup into the render of
 * a 1,000-entry history. The formatters must be created once at module scope.
 */
const realDateTimeFormat = Intl.DateTimeFormat;
const realNumberFormat = Intl.NumberFormat;

interface Counts {
  dateTime: number;
  number: number;
}

/** Imports a fresh copy of the module with Intl construction counted. */
async function importWithCountedIntl(): Promise<{
  module: typeof import("../src/renderer/settings/screens/HistoryInsights");
  atImport: Counts;
  counts: Counts;
}> {
  const counts: Counts = { dateTime: 0, number: 0 };
  Intl.DateTimeFormat = function CountedDateTimeFormat(...args: unknown[]) {
    counts.dateTime += 1;
    return new (realDateTimeFormat as unknown as new (...rest: unknown[]) => object)(...args);
  } as unknown as typeof Intl.DateTimeFormat;
  Intl.NumberFormat = function CountedNumberFormat(...args: unknown[]) {
    counts.number += 1;
    return new (realNumberFormat as unknown as new (...rest: unknown[]) => object)(...args);
  } as unknown as typeof Intl.NumberFormat;

  vi.resetModules();
  const module = await import("../src/renderer/settings/screens/HistoryInsights");
  return { module, atImport: { ...counts }, counts };
}

afterEach(() => {
  Intl.DateTimeFormat = realDateTimeFormat;
  Intl.NumberFormat = realNumberFormat;
  vi.resetModules();
});

describe("history formatter reuse", () => {
  it("constructs its Intl formatters once at import, never per rendered row", async () => {
    const { module, atImport, counts } = await importWithCountedIntl();
    expect(atImport.dateTime + atImport.number).toBeGreaterThan(0);

    counts.dateTime = 0;
    counts.number = 0;

    const points = Array.from({ length: 500 }, (_, index) => ({
      key: `2026-07-${String((index % 28) + 1).padStart(2, "0")}-${index}`,
      words: index * 3,
      label: "M",
      fullLabel: `Day ${index}`,
    }));
    const categories = Array.from({ length: 200 }, (_, index) => ({
      key: `category-${index}`,
      label: `Category ${index}`,
      count: index + 1,
      words: index * 137,
      share: 0.1,
    })) as unknown as Parameters<typeof module.CategoryList>[0]["categories"];

    const chart = renderToStaticMarkup(createElement(module.ActivityChart, { points }));
    const list = renderToStaticMarkup(createElement(module.CategoryList, { categories }));

    expect(chart).toContain("1,497");
    expect(list).toContain("27.3K");
    expect(counts.dateTime).toBe(0);
    expect(counts.number).toBe(0);
  });

  it("keeps the cached formatters byte-identical to per-call construction", async () => {
    const { module } = await importWithCountedIntl();
    Intl.DateTimeFormat = realDateTimeFormat;
    Intl.NumberFormat = realNumberFormat;

    const chart = renderToStaticMarkup(createElement(module.ActivityChart, {
      points: [{ key: "2026-07-22", words: 12_500, label: "W", fullLabel: "Jul 22" }],
    }));
    const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })
      .format(12_500);

    expect(chart).toContain(compact);
  });
});
