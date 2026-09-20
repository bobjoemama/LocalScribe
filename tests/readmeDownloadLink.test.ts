import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Publication is a separate, explicit step. This approved published version
 * deliberately does not follow package.json when the next candidate is built.
 * Update it only after publication and remote asset verification.
 */
const projectRoot = path.resolve(__dirname, "..");
const readme = readFileSync(path.join(projectRoot, "README.md"), "utf8");
const publishedVersion = "0.1.0-dev.20";
const releasesUrl = "https://github.com/bobjoemama/LocalScribe/releases";

describe("README download section", () => {
  it("directs readers to an approved release or a source build", () => {
    expect(readme).toContain(`${releasesUrl}/tag/v${publishedVersion}`);
    expect(readme).toContain("## Build and verify from source");
  });

  it("tells the reader to verify a download against the checksum manifest", () => {
    expect(readme).toContain("SHA256SUMS.txt");
    expect(readme).toContain("shasum -a 256");
  });

  it("separates ordinary installation from developer prerequisites", () => {
    expect(readme).toContain("You do not need Docker, Python, Node.js, Homebrew, Xcode");
    expect(readme).toContain("**Not included:** large speech-model weights");
    expect(readme).toContain("**Microphone**");
    expect(readme).toContain("**Accessibility**");
    expect(readme).toContain("Press **Apply model**");
    expect(readme).toContain("Older previews may not be notarized");
  });

  it("requires a new version and tag instead of overwriting a release", () => {
    expect(readme).toMatch(/every build must have a\s+new version and tag/iu);
    expect(readme).toMatch(/do\s+not replace or overwrite an existing release asset/iu);
  });

  it("links the explicitly published DMG and explains private repository access", () => {
    expect(readme).toContain(`${releasesUrl}/download/v${publishedVersion}/LocalScribe-${publishedVersion}-arm64.dmg`);
    expect(readme).toContain("published prerelease");
    expect(readme).toContain("available to invited repository members");
    expect(readme).toContain("sign in to a GitHub account");
    expect(readme).not.toContain("staged in a draft release");
  });
});
