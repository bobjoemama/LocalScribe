import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Publication is a separate, explicit step. The README therefore describes
 * approved releases and source builds without presenting an unapproved local
 * candidate as a published tag, asset, checksum, or visibility promise.
 */
const projectRoot = path.resolve(__dirname, "..");
const readme = readFileSync(path.join(projectRoot, "README.md"), "utf8");

describe("README download section", () => {
  it("directs readers to an approved release or a source build", () => {
    expect(readme).toContain("GitHub Releases page");
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
    expect(readme).toContain("Check the release notes for its signing status");
  });

  it("requires a new version and tag instead of overwriting a release", () => {
    expect(readme).toMatch(/every build must have a\s+new version and tag/iu);
    expect(readme).toMatch(/do\s+not replace or overwrite an existing release asset/iu);
  });

  it("does not claim that the current package version is already published", () => {
    const packageVersion = JSON.parse(
      readFileSync(path.join(projectRoot, "package.json"), "utf8"),
    ) as { version: string };
    expect(readme).not.toContain(`/releases/tag/v${packageVersion.version}`);
  });
});
