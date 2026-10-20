#!/usr/bin/env node

import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReleaseAssets } from "./release-assets.mts";
import {
  MAC_UPDATE_FEED_NAME,
  macUpdateZipName,
  releaseAssetURL,
  UPDATE_REPOSITORY,
  updateVersionSchema,
  validateMacUpdateFeed,
} from "../src/main/updates/releaseFeed.mts";

/** Consume the existing verifier's exact-byte inventory; hash metadata is not native enforcement. */
export function generateMacUpdateFeed(verified, { publishedAt, notes }) {
  const version = updateVersionSchema.parse(verified.version);
  if (verified.repository !== UPDATE_REPOSITORY || verified.productName !== "LocalScribe"
    || verified.platform !== "darwin" || verified.arch !== "arm64" || verified.tag !== `v${version}`) {
    throw new Error("Verified release is not the supported LocalScribe Mac release.");
  }
  const name = macUpdateZipName(version);
  const archives = verified.assets.filter((asset) => asset.name === name);
  if (archives.length !== 1 || !Number.isSafeInteger(archives[0].bytes) || archives[0].bytes <= 0
    || archives[0].bytes >= 2 * 1024 ** 3 || !/^[a-f0-9]{64}$/u.test(archives[0].sha256)
    || path.basename(archives[0].path) !== name) {
    throw new Error("Verified release must contain the exact nonempty update ZIP.");
  }
  const release = {
    version, tag: verified.tag, zipURL: releaseAssetURL(version, name),
    feedURL: releaseAssetURL(version, MAC_UPDATE_FEED_NAME),
  };
  return validateMacUpdateFeed({
    version, tag: release.tag, url: release.zipURL, name: `LocalScribe ${version}`,
    notes, pub_date: publishedAt,
  }, release);
}

async function run() {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== "--published-at" || args[2] !== "--notes-file" || args[4] !== "--output") {
    throw new Error("Usage: node scripts/generate-mac-update-feed.mjs --published-at <ISO8601> --notes-file <plain-text-file> --output <LocalScribe-macos-arm64-update.json>");
  }
  if (path.basename(args[5]) !== MAC_UPDATE_FEED_NAME) throw new Error(`Output basename must be ${MAC_UPDATE_FEED_NAME}.`);
  // Existing verification re-hashes the exact local artifacts and checksum inventory.
  // Signing/notarization verification remains the separate release gate.
  const verified = await verifyReleaseAssets("darwin");
  const feed = generateMacUpdateFeed(verified, {
    publishedAt: args[1], notes: readFileSync(args[3], "utf8"),
  });
  writeFileSync(args[5], `${JSON.stringify(feed, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => { console.error(error); process.exitCode = 1; });
}
