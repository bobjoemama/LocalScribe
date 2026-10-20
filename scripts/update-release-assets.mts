import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import type { VerifiedReleaseAssets } from "./release-assets.mts";
import { MAC_UPDATE_FEED_NAME, MAX_FEED_BYTES, UPDATE_REPOSITORY,
  macUpdateZipName, releaseAssetURL, validateMacUpdateFeed } from "../src/main/updates/releaseFeed.mts";

/** Publication adds the feed after the original checksum inventory is verified. */
export function withVerifiedMacUpdateFeed(verified: VerifiedReleaseAssets, projectPath = process.cwd()): VerifiedReleaseAssets {
  if (verified.repository !== UPDATE_REPOSITORY || verified.productName !== "LocalScribe"
    || verified.platform !== "darwin" || verified.arch !== "arm64" || verified.tag !== `v${verified.version}`
    || verified.assets.filter((asset) => asset.name === macUpdateZipName(verified.version)).length !== 1) {
    throw new Error("Update publication requires the exact verified LocalScribe Mac release.");
  }
  const feedPath = path.resolve(projectPath, "out", "make", MAC_UPDATE_FEED_NAME);
  const descriptor = openSync(feedPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size <= 0 || before.size > MAX_FEED_BYTES) throw new Error("Invalid update feed file.");
    const buffer = Buffer.alloc(MAX_FEED_BYTES + 1);
    let count = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, count, buffer.length - count, null);
      if (read === 0) break;
      count += read;
      if (count > MAX_FEED_BYTES) throw new Error("Update feed exceeds its byte limit.");
    }
    const after = fstatSync(descriptor);
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("Update feed changed during verification.");
    bytes = buffer.subarray(0, count);
  } finally { closeSync(descriptor); }
  validateMacUpdateFeed(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), {
    version: verified.version, tag: verified.tag,
    zipURL: releaseAssetURL(verified.version, macUpdateZipName(verified.version)),
    feedURL: releaseAssetURL(verified.version, MAC_UPDATE_FEED_NAME),
  });
  return { ...verified, assets: [...verified.assets, {
    path: feedPath, name: MAC_UPDATE_FEED_NAME, bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }] };
}
