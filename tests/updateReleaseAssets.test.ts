import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withVerifiedMacUpdateFeed } from "../scripts/update-release-assets.mts";
import type { VerifiedReleaseAssets } from "../scripts/release-assets.mts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "localscribe-update-publication-")); roots.push(root);
  mkdirSync(path.join(root, "out", "make"), { recursive: true });
  const name = "LocalScribe-macos-arm64-update.json";
  const file = path.join(root, "out", "make", name);
  const feed = { version: "0.1.0-dev.25", tag: "v0.1.0-dev.25", name: "LocalScribe 0.1.0-dev.25",
    url: "https://github.com/bobjoemama/LocalScribe/releases/download/v0.1.0-dev.25/LocalScribe-darwin-arm64-0.1.0-dev.25.zip",
    notes: "Signed updates.", pub_date: "2026-10-19T12:00:00Z" };
  const inventory: VerifiedReleaseAssets = { repository: "bobjoemama/LocalScribe", version: feed.version, tag: feed.tag,
    productName: "LocalScribe", prerelease: true, platform: "darwin", arch: "arm64", checksumPath: "/verified/SHA256SUMS.txt",
    assets: [{ name: "LocalScribe-darwin-arm64-0.1.0-dev.25.zip", path: "/verified/archive.zip", bytes: 123, sha256: "a".repeat(64) }] };
  return { root, name, file, feed, inventory };
}
describe("publication feed completeness", () => {
  it("returns the feed with an exact digest alongside the unchanged verified inventory", () => {
    const f = fixture(); const bytes = Buffer.from(JSON.stringify(f.feed)); writeFileSync(f.file, bytes);
    const result = withVerifiedMacUpdateFeed(f.inventory, f.root);
    expect(result.assets).toEqual([...f.inventory.assets, { name: f.name, path: f.file, bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") }]);
    expect(f.inventory.assets).toHaveLength(1);
  });
  it("refuses publication without an update feed", () => {
    const f = fixture(); expect(() => withVerifiedMacUpdateFeed(f.inventory, f.root)).toThrow();
  });
  it.each([{ version: "0.1.0-dev.24" }, { tag: "v0.1.0-dev.24" }, { url: "https://example.com/app.zip" }, { name: "Other" }])(
    "rejects a feed that does not match its verified release: %j", (patch) => {
      const f = fixture(); writeFileSync(f.file, JSON.stringify({ ...f.feed, ...patch }));
      expect(() => withVerifiedMacUpdateFeed(f.inventory, f.root)).toThrow();
    });
  it("rejects symlinks, oversized files and malformed UTF-8", () => {
    const f = fixture(); const outside = path.join(f.root, "source.json"); writeFileSync(outside, JSON.stringify(f.feed));
    symlinkSync(outside, f.file); expect(() => withVerifiedMacUpdateFeed(f.inventory, f.root)).toThrow(); rmSync(f.file);
    writeFileSync(f.file, " ".repeat(65537)); expect(() => withVerifiedMacUpdateFeed(f.inventory, f.root)).toThrow();
    writeFileSync(f.file, Buffer.from([0xc3, 0x28])); expect(() => withVerifiedMacUpdateFeed(f.inventory, f.root)).toThrow();
  });
});
