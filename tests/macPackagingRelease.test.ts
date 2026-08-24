import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function projectFile(relativePath: string): string {
  return readFileSync(path.resolve(root, relativePath), "utf8");
}

describe("macOS package release gates", () => {
  it("ties a freshly built Vite tree and packaged archive to source provenance", () => {
    const forge = projectFile("forge.config.ts");
    const smoke = projectFile("scripts/smoke-packaged-macos.sh");

    expect(forge).toContain("packageBuildStartedAtMs = Date.now()");
    expect(forge).toContain("assertFreshViteBuild(buildPath, packageBuildStartedAtMs)");
    expect(forge).toContain("writePackageProvenance(buildPath, packageProvenanceExpectation)");
    expect(forge).toContain("assertPackagedArchive({");
    expect(forge).toContain("verify-packaged-main.mjs");
    expect(smoke).toContain("verify-packaged-archive.mjs");
  });

  it("checks the macOS identity, deployment floor, fuses, ASAR hash, and signature", () => {
    const forge = projectFile("forge.config.ts");
    const bundleVerifier = projectFile("scripts/verify-macos-bundle.mjs");
    const releasePolicy = projectFile("src/shared/releasePolicy.mts");

    expect(releasePolicy).toContain('minimumMacOSVersion: "14.0"');
    expect(forge).toContain(
      "LSMinimumSystemVersion: RELEASE_METADATA.minimumMacOSVersion",
    );
    expect(forge).toContain(
      "`${targetArchitecture}-apple-macos${RELEASE_METADATA.minimumMacOSVersion}`",
    );
    expect(forge).toContain("verify-macos-bundle.mjs");
    expect(bundleVerifier).toContain("ElectronAsarIntegrity");
    expect(bundleVerifier).toContain("getCurrentFuseWire");
    expect(bundleVerifier).toContain("CFBundleIdentifier");
    expect(bundleVerifier).toContain("RELEASE_METADATA.productName");
    expect(bundleVerifier).toContain('"--verify", "--deep", "--strict"');
  });

  it("opens both installer formats and requires the exact staged signed app", () => {
    const forge = projectFile("forge.config.ts");
    const artifactVerifier = projectFile("scripts/verify-macos-artifacts.mjs");

    expect(forge).toContain("macOS make expected one DMG and one ZIP");
    expect(forge).toContain("verify-macos-artifacts.mjs");
    expect(artifactVerifier).toContain("await preflightMacApplicationZip(");
    expect(artifactVerifier.indexOf("await preflightMacApplicationZip(")).toBeLessThan(
      artifactVerifier.indexOf('"ditto", ["-x", "-k"'),
    );
    expect(artifactVerifier).toContain('"attach"');
    expect(artifactVerifier).toContain('"ditto", ["-x", "-k"');
    expect(artifactVerifier).toContain('readlinkSync(applicationsLink) !== "/Applications"');
    expect(artifactVerifier).toContain("does not carry the exact staged app code signature");
    expect(artifactVerifier).toContain("does not carry the exact staged app.asar");
  });

  it("uses a Keychain profile without accepting notarization secrets in argv", () => {
    const forge = projectFile("forge.config.ts");
    const releaseDocs = projectFile("docs/RELEASING.md");

    expect(forge).toContain('requireReleaseEnvironment("APPLE_KEYCHAIN_PROFILE")');
    expect(forge).toContain('"--keychain-profile"');
    expect(forge).not.toContain("APPLE_APP_SPECIFIC_PASSWORD");
    expect(forge).not.toContain('"--password"');
    expect(releaseDocs).toContain("notarytool store-credentials");
    expect(releaseDocs).toContain("never places a notarization");
  });
});
