import type { Transcription } from "./contracts";

export type InsightRange = "7d" | "30d" | "recent";
export type AppCategoryKey =
  | "personal"
  | "work"
  | "ai"
  | "documents"
  | "email"
  | "development"
  | "browser"
  | "other";

export type AppCategory = {
  key: AppCategoryKey;
  label: string;
};

export type AppCategoryBreakdown = AppCategory & {
  count: number;
  words: number;
  percent: number;
};

export type ActivityPoint = {
  key: string;
  words: number;
  label: string;
  fullLabel: string;
};

const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
const DAY_MS = 86_400_000;

/**
 * Small, product-neutral display-name overrides for ubiquitous application
 * identifiers. Unknown identifiers intentionally fall through to the generic
 * formatter below; this avoids carrying personal-machine aliases in builds.
 */
const FRIENDLY_APP_NAMES: Record<string, string> = {
  "com.apple.mobilesms": "Messages",
  "com.apple.mail": "Mail",
  "com.apple.notes": "Notes",
  "com.apple.pages": "Pages",
  "com.apple.safari": "Safari",
  "com.google.chrome": "Chrome",
  "com.microsoft.vscode": "Visual Studio Code",
  "com.microsoft.teams2": "Microsoft Teams",
  "com.tinyspeck.slackmacgap": "Slack",
  "com.localscribe.desktop": "LocalScribe",
};

const GENERIC_BUNDLE_SEGMENTS = new Set([
  "app", "application", "beta", "com", "desktop", "dev", "exe", "io", "net", "nightly", "org", "release", "stable",
]);

export function countWords(text: string): number {
  return text.match(WORD_PATTERN)?.length ?? 0;
}

export function friendlyAppName(sourceAppId: string | null | undefined): string {
  if (!sourceAppId) return "Unknown app";
  const normalized = sourceAppId.toLocaleLowerCase();
  const knownName = FRIENDLY_APP_NAMES[normalized];
  if (knownName) return knownName;
  return genericFriendlyApplicationName(sourceAppId);
}

function genericFriendlyApplicationName(sourceAppId: string): string {
  const segments = sourceAppId
    .replace(/\\/gu, "/")
    .split(/[/.]/)
    .filter(Boolean);
  const candidate = [...segments]
    .reverse()
    .find((segment) => !GENERIC_BUNDLE_SEGMENTS.has(segment.toLocaleLowerCase()))
    ?? segments.at(-1)
    ?? sourceAppId;
  return candidate
    .replace(/\.exe$/iu, "")
    .replace(/[-_]+/gu, " ")
    .replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}

export function appCategory(sourceAppId: string | null | undefined): AppCategory {
  const app = sourceAppId?.toLocaleLowerCase() ?? "";
  if (!app) return { key: "other", label: "Other tasks" };
  if (/(chatgpt|openai|claude|anthropic|perplexity|lmstudio|lm studio|ollama|codex)/.test(app)) {
    return { key: "ai", label: "AI prompts" };
  }
  if (/(apple\.mobilesms|whatsapp|telegram|signal|messenger|personal.?message)/.test(app)) {
    return { key: "personal", label: "Personal messages" };
  }
  if (/(slack|teams|discord|zoom|work.?message)/.test(app)) {
    return { key: "work", label: "Work messages" };
  }
  if (/(apple\.mail|outlook|spark|airmail|thunderbird|superhuman|hey\.email|protonmail)/.test(app)) {
    return { key: "email", label: "Emails" };
  }
  if (/(notion|obsidian|microsoft\.word|\.word|pages|google.*docs|notes|bear|ulysses|craft)/.test(app)) {
    return { key: "documents", label: "Documents" };
  }
  if (/(cmux|vscode|visual.?studio|xcode|terminal|iterm|warp|github|jetbrains|cursor|zed)/.test(app)) {
    return { key: "development", label: "Development" };
  }
  if (/(safari|chrome|firefox|arc|edge|zen|browser)/.test(app)) {
    return { key: "browser", label: "Browsing" };
  }
  return { key: "other", label: "Other tasks" };
}

export function categoryBreakdown(items: Transcription[]): AppCategoryBreakdown[] {
  const totals = new Map<AppCategoryKey, Omit<AppCategoryBreakdown, "percent">>();
  items.forEach((item) => {
    const category = appCategory(item.sourceAppId);
    const current = totals.get(category.key) ?? { ...category, count: 0, words: 0 };
    current.count += 1;
    current.words += countWords(item.text);
    totals.set(category.key, current);
  });

  const totalWords = [...totals.values()].reduce((total, category) => total + category.words, 0);
  const totalSessions = [...totals.values()].reduce((total, category) => total + category.count, 0);
  return [...totals.values()]
    .sort((a, b) => b.words - a.words || b.count - a.count || a.label.localeCompare(b.label))
    .map((category) => ({
      ...category,
      percent: totalWords > 0
        ? Math.round((category.words / totalWords) * 100)
        : totalSessions > 0
          ? Math.round((category.count / totalSessions) * 100)
          : 0,
    }));
}

export function filterByRange(items: Transcription[], range: InsightRange, now = Date.now()): Transcription[] {
  if (range === "recent") return items;
  const days = range === "7d" ? 7 : 30;
  const cutoff = startOfLocalDay(now) - ((days - 1) * DAY_MS);
  return items.filter((item) => item.createdAt >= cutoff);
}

export function rangeLabel(range: InsightRange): string {
  if (range === "7d") return "7 days";
  if (range === "30d") return "30 days";
  return "Recent 500";
}

export function recentActivity(items: Transcription[], days: number, now = Date.now()): ActivityPoint[] {
  const wordCounts = new Map<string, number>();
  items.forEach((item) => {
    const key = dateKey(item.createdAt);
    wordCounts.set(key, (wordCounts.get(key) ?? 0) + countWords(item.text));
  });
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(now);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - (days - index - 1));
    const key = dateKey(date.getTime());
    return {
      key,
      words: wordCounts.get(key) ?? 0,
      label: index % Math.max(1, Math.ceil(days / 7)) === 0
        ? new Intl.DateTimeFormat(undefined, { weekday: "narrow" }).format(date)
        : "",
      fullLabel: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date),
    };
  });
}

export function activityForRange(items: Transcription[], range: InsightRange, now = Date.now()): ActivityPoint[] {
  if (range === "7d") return recentActivity(items, 7, now);
  if (range === "30d") return recentActivity(items, 30, now);
  if (items.length === 0) return [];

  const ordinals = items.map((item) => localDayOrdinal(item.createdAt));
  const firstOrdinal = Math.min(...ordinals);
  const lastOrdinal = Math.max(...ordinals);
  const totalDays = lastOrdinal - firstOrdinal + 1;
  const bucketDays = Math.max(1, Math.ceil(totalDays / 30));
  const bucketCount = Math.ceil(totalDays / bucketDays);
  const totals = Array.from({ length: bucketCount }, () => 0);

  items.forEach((item) => {
    const bucket = Math.min(bucketCount - 1, Math.floor((localDayOrdinal(item.createdAt) - firstOrdinal) / bucketDays));
    totals[bucket] = (totals[bucket] ?? 0) + countWords(item.text);
  });

  return totals.map((wordCount, index) => {
    const start = firstOrdinal + index * bucketDays;
    const end = Math.min(lastOrdinal, start + bucketDays - 1);
    const startLabel = formatOrdinal(start);
    const endLabel = formatOrdinal(end);
    return {
      key: `${start}-${end}`,
      words: wordCount,
      label: index % Math.max(1, Math.ceil(bucketCount / 7)) === 0 ? shortOrdinalLabel(start) : "",
      fullLabel: start === end ? startLabel : `${startLabel} – ${endLabel}`,
    };
  });
}

export function calculateStreak(items: Transcription[], now = Date.now()): number {
  if (items.length === 0) return 0;
  const ordinals = new Set(items.map((item) => localDayOrdinal(item.createdAt)));
  let cursor = localDayOrdinal(now);
  if (!ordinals.has(cursor)) cursor -= 1;
  if (!ordinals.has(cursor)) return 0;
  let streak = 0;
  while (ordinals.has(cursor)) {
    streak += 1;
    cursor -= 1;
  }
  return streak;
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dateKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localDayOrdinal(timestamp: number): number {
  const date = new Date(timestamp);
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

function formatOrdinal(ordinal: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(ordinal * DAY_MS));
}

function shortOrdinalLabel(ordinal: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric", timeZone: "UTC" }).format(new Date(ordinal * DAY_MS));
}
