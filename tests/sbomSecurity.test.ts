import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

function projectFile(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("platform SBOM generation", () => {
  it("exports separate core-runtime and locked platform Python CycloneDX graphs", () => {
    const packageJson = JSON.parse(projectFile("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["sbom:runtime:macos"]).toBe(
      "node scripts/generate-runtime-sbom.mjs --platform darwin --source-only",
    );
    expect(packageJson.scripts["sbom:runtime:macos:candidate"]).toBe(
      "node scripts/generate-runtime-sbom.mjs --platform darwin",
    );
    expect(packageJson.scripts["sbom:python:macos"]).toBe(
      "uv export --project worker --locked --no-dev --format cyclonedx1.5 --preview-features sbom-export",
    );
  });

  it("generates and checksums the macOS SBOM pair during local verification", () => {
    const localMacVerification = projectFile("scripts/verify-local-macos.sh");

    expect(localMacVerification.match(
      /npm run --silent sbom:runtime:macos:candidate/g,
    )).toHaveLength(1);
    expect(localMacVerification.match(
      /npm run --silent sbom:python:macos/g,
    )).toHaveLength(1);
    expect(localMacVerification).toContain("core_sbom");
    expect(localMacVerification).toContain("python_sbom");
    expect(localMacVerification).toContain("reconcile-python-sbom.py");
    expect(localMacVerification).toContain('--app "$app_path"');
    expect(localMacVerification).toContain("release-metadata.mjs");
    expect(localMacVerification).toContain("set -euo pipefail");
    expect(localMacVerification).toContain("checksum_path");
    expect(localMacVerification).toContain("asset_name=\"$(basename \"$artifact\")\"");
    expect(localMacVerification).toContain("verify-release-assets.mjs --platform darwin --candidate");
  });


});
