import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Publication is a separate, explicit step. This approved published version
 * deliberately does not follow package.json when the next candidate is built.
 * Update it only after publication and remote asset verification.
 */
const projectRoot = path.resolve(__dirname, "..");
const readme = readFileSync(path.join(projectRoot, "README.md"), "utf8");
const normalizeWhitespace = (value: string): string => value.replace(/\s+/gu, " ").trim();
const readmeText = normalizeWhitespace(readme);
const releasingText = normalizeWhitespace(
  readFileSync(path.join(projectRoot, "docs/RELEASING.md"), "utf8"),
);
const readmeLinks = Array.from(readme.matchAll(/\[([^\]]+)\]\(([^)]+)\)/gu), (match) => ({
  label: match[1] ?? "",
  target: match[2] ?? "",
}));
const approvedRelease: {
  version: string;
  interface: "older" | "redesigned";
  pendingLabel: string | null;
} = {
  version: "0.1.0-dev.21",
  interface: "redesigned",
  pendingLabel: null,
};
const releasesUrl = "https://github.com/bobjoemama/LocalScribe/releases";
const publishedTagUrl = `${releasesUrl}/tag/v${approvedRelease.version}`;
const publishedDmgUrl = `${releasesUrl}/download/v${approvedRelease.version}/LocalScribe-${approvedRelease.version}-arm64.dmg`;

describe("README download section", () => {
  it("directs readers to an approved release or a source build", () => {
    expect(readmeLinks.some((link) => link.target === publishedTagUrl)).toBe(true);
    const sourceGuide = readmeLinks.find((link) => /build.*source/iu.test(link.label));
    expect(sourceGuide?.target).toBe("docs/RELEASING.md");
    expect(existsSync(path.resolve(projectRoot, sourceGuide?.target ?? "__missing_source_guide__"))).toBe(true);
  });

  it("tells the reader to verify a download against the checksum manifest", () => {
    expect(readmeText).toContain("checksum manifest");
    const checksumGuide = readmeLinks.find((link) => /release notes and checksums/iu.test(link.label));
    expect(checksumGuide?.target).toBe(publishedTagUrl);
    expect(readmeText).toContain("every file it lists into one folder");
    expect(readmeText).toContain("shasum -a 256 -c LocalScribe-<version>-macos-arm64-SHA256SUMS.txt");
    expect(readmeText).toMatch(/each line should say `OK`/iu);
  });

  it("separates ordinary installation from developer prerequisites", () => {
    expect(readmeText).toContain("The app includes its runtimes");
    const prerequisites = readmeText.match(/You do not need\b.*?\.(?= |$)/u)?.[0] ?? "";
    for (const prerequisite of ["Docker", "Python", "Node.js", "Homebrew", "Xcode"]) {
      expect(prerequisites).toContain(prerequisite);
    }
    expect(prerequisites).toContain("use Terminal");
    expect(readmeText).toMatch(/Large speech-model (?:files|weights) are downloaded separately/iu);
    expect(readmeText).toContain("Choose a model and download its files");
    expect(readmeText).toContain("**Microphone** access for recording");
    expect(readmeText).toContain("**Accessibility** access for automatic text insertion");
    expect(readmeText).toMatch(/(?:Click|Press) \*\*Apply model\*\*/u);
    expect(readmeText).toContain("Downloading does not activate a model; apply it to load it");
    expect(readmeText).toContain("The default is **Control + Space**");
    expect(readmeText).toContain("Use the shortcuts shown in Settings if you have saved different ones");
  });

  it("requires a new version and tag instead of overwriting a release", () => {
    expect(releasingText).toContain("Every uploaded build must use a new semantic prerelease version");
    expect(releasingText).toContain("create a matching annotated tag");
    expect(releasingText).toContain("Never reuse a tag or overwrite an existing release asset with different bytes");
    expect(releasingText).toContain("do not delete or replace a reviewed asset in place");
  });

  it("links the explicitly published DMG without obsolete access restrictions", () => {
    expect(readmeLinks.filter((link) => link.target.startsWith(`${releasesUrl}/download/`))
      .map((link) => link.target)).toEqual([publishedDmgUrl]);
    const publication = readmeText.match(/Latest public download: .*?prerelease[^.]*\./u)?.[0] ?? "";
    expect(publication).toContain(publishedTagUrl);
    expect(publication).toContain("Developer ID-signed");
    expect(publication).toContain("Apple-notarized prerelease");
    expect(publication).toContain(`(${approvedRelease.interface} interface)`);
    if (approvedRelease.pendingLabel) {
      expect(readmeText).toContain(`${approvedRelease.pendingLabel} has no public DMG yet`);
    } else {
      expect(readmeText).not.toMatch(/dev\.\d+ has no public DMG yet/u);
    }
    expect(readmeText).not.toContain("repository is currently private");
    expect(readmeText).not.toContain("available to invited repository members");
    expect(readmeText).not.toContain("staged in a draft release");
  });
});
