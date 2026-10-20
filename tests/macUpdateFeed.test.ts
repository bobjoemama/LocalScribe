import { describe, expect, it } from "vitest";
// @ts-expect-error The executable release script is JavaScript, outside the TypeScript project.
import { generateMacUpdateFeed } from "../scripts/generate-mac-update-feed.mjs";
import { supportedMacRelease, validateMacUpdateFeed } from "../src/main/updates/releaseFeed.mts";

function verified() {
  return {
    repository: "bobjoemama/LocalScribe", productName: "LocalScribe",
    version: "0.1.0-dev.25", tag: "v0.1.0-dev.25", prerelease: true,
    platform: "darwin", arch: "arm64",
    assets: [{ name: "LocalScribe-darwin-arm64-0.1.0-dev.25.zip",
      path: "/verified/LocalScribe-darwin-arm64-0.1.0-dev.25.zip", bytes: 12345, sha256: "a".repeat(64) }],
  };
}
const options = { publishedAt: "2026-10-19T12:00:00Z", notes: "Fix insertion.\n日本語 release notes." };

describe("Mac static update feed generator", () => {
  it("emits the exact default Squirrel feed accepted by runtime for the verified release", () => {
    const output = generateMacUpdateFeed(verified(), options);
    expect(output).toEqual({
      version: "0.1.0-dev.25", tag: "v0.1.0-dev.25", name: "LocalScribe 0.1.0-dev.25",
      url: "https://github.com/bobjoemama/LocalScribe/releases/download/v0.1.0-dev.25/LocalScribe-darwin-arm64-0.1.0-dev.25.zip",
      notes: "Fix insertion.\n日本語 release notes.", pub_date: "2026-10-19T12:00:00Z",
    });
    const release = supportedMacRelease({
      tag_name: "v0.1.0-dev.25", html_url: "https://github.com/bobjoemama/LocalScribe/releases/tag/v0.1.0-dev.25",
      draft: false, prerelease: true, assets: [
        { name: "LocalScribe-darwin-arm64-0.1.0-dev.25.zip", browser_download_url: output.url, state: "uploaded", size: 12345 },
        { name: "LocalScribe-macos-arm64-update.json", state: "uploaded", size: 400,
          browser_download_url: "https://github.com/bobjoemama/LocalScribe/releases/download/v0.1.0-dev.25/LocalScribe-macos-arm64-update.json" },
      ],
    });
    expect(release).toBeDefined();
    expect(validateMacUpdateFeed(JSON.parse(JSON.stringify(output)), release!)).toEqual(output);
    // No hash/size keys imply guarantees the native downloader does not provide.
    expect(output).not.toHaveProperty("sha256"); expect(output).not.toHaveProperty("size");
  });

  it.each([
    { repository: "attacker/LocalScribe" }, { productName: "Other" }, { platform: "win32" },
    { arch: "x64" }, { tag: "v0.1.0-dev.26" }, { version: "0.1.0-dev.01" }, { assets: [] },
  ])("rejects a verified inventory for a different or unsupported release: %j", (patch) => {
    expect(() => generateMacUpdateFeed({ ...verified(), ...patch }, options)).toThrow();
  });

  it.each([
    { name: "LocalScribe-darwin-arm64-0.1.0-dev.24.zip" },
    { bytes: 0 }, { bytes: 2 * 1024 ** 3 }, { bytes: 1.5 }, { sha256: "unverified" },
    { path: "/verified/wrong.zip" },
  ])("requires the exact verified nonempty ZIP: %j", (patch) => {
    const value = verified(); Object.assign(value.assets[0]!, patch);
    expect(() => generateMacUpdateFeed(value, options)).toThrow();
  });

  it("rejects duplicate ZIPs and oversized or malformed plain-text feed fields", () => {
    const value = verified(); value.assets.push(value.assets[0]!);
    expect(() => generateMacUpdateFeed(value, options)).toThrow();
    for (const patch of [{ notes: "x".repeat(16001) }, { notes: "bad\u0000" }, { publishedAt: "yesterday" }]) {
      expect(() => generateMacUpdateFeed(verified(), { ...options, ...patch })).toThrow();
    }
  });
});
