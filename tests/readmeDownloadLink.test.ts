import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadReleaseMetadata, releaseLayout } from "../scripts/release-metadata.mts";

/*
 * The README's download link is the product's only distribution path, and it
 * was dead: it pointed at `/releases`, which lists nothing to an anonymous
 * visitor of a private repository, and every release after v0.1.0-dev.1 was
 * left in draft. Nothing in the repository could notice, because release
 * filenames come from `package.json` + `releasePolicy.mts` while the README
 * spelled them by hand.
 *
 * This binds the two together offline: bump the version and the README has to
 * be updated in the same commit or the suite fails. It cannot prove the release
 * exists on GitHub — only that the link the README makes is the one this
 * version's artifacts would be published under.
 */
const projectRoot = path.resolve(__dirname, "..");
const readme = readFileSync(path.join(projectRoot, "README.md"), "utf8");
const metadata = loadReleaseMetadata(projectRoot);
const layout = releaseLayout(metadata, "darwin", projectRoot);

describe("README download section", () => {
  it("deep-links the release tag for the current package version", () => {
    expect(readme).toContain(
      `https://github.com/${metadata.repository}/releases/tag/${layout.tag}`,
    );
  });

  it("names the exact DMG this version produces", () => {
    const dmg = layout.primaryArtifactNames.find((name) => name.endsWith(".dmg"));
    expect(dmg).toBeDefined();
    expect(readme).toContain(dmg!);
  });

  /*
   * A reader without repository access gets a 404, not a download page. The
   * README has to say so, and has to leave them somewhere to go.
   */
  it("states that the repository is private and offers the source build", () => {
    expect(readme).toMatch(/repository is private/iu);
    expect(readme).toContain("#build-from-source");
    expect(readme).toContain("## Build from source");
  });

  it("tells the reader to verify the download against the checksum manifest", () => {
    expect(readme).toContain("SHA256SUMS.txt");
    expect(readme).toContain("shasum -a 256");
  });

  /*
   * `/releases` bare is what was broken. Deep links to a specific tag are fine;
   * a bare listing link is not.
   */
  it("does not send the reader to the bare releases listing", () => {
    expect(readme).not.toContain(
      `https://github.com/${metadata.repository}/releases)`,
    );
  });
});
