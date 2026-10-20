import { z } from "zod";

export const UPDATE_REPOSITORY = "bobjoemama/LocalScribe";
export const MAC_UPDATE_FEED_NAME = "LocalScribe-macos-arm64-update.json";
export const MAX_FEED_BYTES = 64 * 1024;
export const MAX_RELEASE_PAGE_BYTES = 2 * 1024 * 1024;
export const METADATA_TIMEOUT_MS = 15_000;
export const MAX_RELEASE_PAGES = 10;

const exactSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
export const updateVersionSchema = z.string().max(256).regex(exactSemver);

/** Full SemVer precedence, including numeric prerelease identifiers and ignored build metadata. */
export function compareUpdateVersions(left: string, right: string): number {
  const a = exactSemver.exec(updateVersionSchema.parse(left))!;
  const b = exactSemver.exec(updateVersionSchema.parse(right))!;
  for (const index of [1, 2, 3]) {
    const x = BigInt(a[index]!);
    const y = BigInt(b[index]!);
    if (x !== y) return x > y ? 1 : -1;
  }
  if (a[4] === b[4]) return 0;
  if (a[4] === undefined) return 1;
  if (b[4] === undefined) return -1;
  const x = a[4].split(".");
  const y = b[4].split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const p = x[i];
    const q = y[i];
    if (p === q) continue;
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/u.test(p);
    const qn = /^\d+$/u.test(q);
    if (pn && qn) return BigInt(p) > BigInt(q) ? 1 : -1;
    if (pn !== qn) return pn ? -1 : 1;
    return p > q ? 1 : -1;
  }
  return 0;
}

export function macUpdateZipName(version: string): string {
  return `LocalScribe-darwin-arm64-${updateVersionSchema.parse(version)}.zip`;
}

export function releaseAssetURL(version: string, name: string): string {
  return `https://github.com/${UPDATE_REPOSITORY}/releases/download/${encodeURIComponent(`v${version}`)}/${encodeURIComponent(name)}`;
}

const assetSchema = z.object({
  name: z.string(),
  browser_download_url: z.string(),
  state: z.literal("uploaded"),
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const releaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.string(),
  draft: z.literal(false),
  prerelease: z.boolean(),
  assets: z.array(z.unknown()).max(1000),
});

export interface MacUpdateRelease {
  version: string;
  tag: string;
  zipURL: string;
  feedURL: string;
}

/** Unsupported/old releases stay out of the channel; GitHub's prerelease flag is allowed. */
export function supportedMacRelease(raw: unknown): MacUpdateRelease | undefined {
  const parsed = releaseSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const release = parsed.data;
  const version = release.tag_name.startsWith("v") ? release.tag_name.slice(1) : "";
  if (!updateVersionSchema.safeParse(version).success) return undefined;
  if (release.html_url !== `https://github.com/${UPDATE_REPOSITORY}/releases/tag/${encodeURIComponent(release.tag_name)}`) return undefined;
  const zipName = macUpdateZipName(version);
  const zipURL = releaseAssetURL(version, zipName);
  const feedURL = releaseAssetURL(version, MAC_UPDATE_FEED_NAME);
  const matching = (name: string, url: string, maximum: number) => {
    const matches = release.assets.filter((item) => typeof item === "object" && item !== null && "name" in item && item.name === name);
    if (matches.length !== 1) return false;
    const asset = assetSchema.safeParse(matches[0]);
    return asset.success && asset.data.browser_download_url === url && asset.data.size <= maximum;
  };
  if (!matching(zipName, zipURL, 2 * 1024 ** 3 - 1) || !matching(MAC_UPDATE_FEED_NAME, feedURL, MAX_FEED_BYTES)) return undefined;
  return { version, tag: release.tag_name, zipURL, feedURL };
}

/** Default Squirrel release-server response; extra version/tag fields bind JS validation. */
export const macUpdateFeedSchema = z.object({
  version: updateVersionSchema,
  tag: z.string().max(257),
  url: z.string().max(2048),
  name: z.string().max(300),
  notes: z.string().max(16_000).refine((text) => !Array.from(text).some((character) => {
    const code = character.charCodeAt(0);
    return code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13);
  })),
  pub_date: z.iso.datetime({ offset: true }),
}).strict();

export function validateMacUpdateFeed(raw: unknown, release: MacUpdateRelease) {
  const feed = macUpdateFeedSchema.parse(raw);
  if (feed.version !== release.version || feed.tag !== release.tag || feed.url !== release.zipURL || feed.name !== `LocalScribe ${release.version}`) {
    throw new Error("Update feed does not match the selected release.");
  }
  return feed;
}
