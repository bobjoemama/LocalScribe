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
      "node scripts/generate-runtime-sbom.mjs --platform darwin",
    );
    expect(packageJson.scripts["sbom:runtime:windows"]).toBe(
      "node scripts/generate-runtime-sbom.mjs --platform win32",
    );
    expect(packageJson.scripts["sbom:python:macos"]).toBe(
      "uv export --project worker --locked --no-dev --format cyclonedx1.5 --preview-features sbom-export",
    );
    expect(packageJson.scripts["sbom:python:windows"]).toBe(
      "uv export --project worker/windows_transformers --locked --no-dev --format cyclonedx1.5 --preview-features sbom-export",
    );
  });

  it("generates and checksums the macOS SBOM pair during local verification", () => {
    const localMacVerification = projectFile("scripts/verify-local-macos.sh");

    expect(localMacVerification.match(
      /npm run --silent sbom:runtime:macos/g,
    )).toHaveLength(1);
    expect(localMacVerification.match(
      /npm run --silent sbom:python:macos/g,
    )).toHaveLength(1);
    expect(localMacVerification).toContain(
      "out/localscribe-core-runtime-macos-sbom.cdx.json",
    );
    expect(localMacVerification).toContain(
      "out/localscribe-python-macos-sbom.cdx.json",
    );
    expect(localMacVerification).toContain("set -euo pipefail");
    expect(localMacVerification).toContain("SHA256SUMS.txt");
    expect(localMacVerification).toContain("shasum -a 256 -c SHA256SUMS.txt");
  });

  it("generates and checksums the Windows SBOM pair during local verification", () => {
    const localWindowsVerification = projectFile("scripts/verify-local-windows.ps1");

    expect(localWindowsVerification.match(
      /sbom:runtime:windows/g,
    )).toHaveLength(1);
    expect(localWindowsVerification.match(
      /sbom:python:windows/g,
    )).toHaveLength(1);
    expect(localWindowsVerification).toContain(
      "out\\localscribe-core-runtime-windows-sbom.cdx.json",
    );
    expect(localWindowsVerification).toContain(
      "out\\localscribe-python-windows-sbom.cdx.json",
    );
    expect(localWindowsVerification).toContain("SHA256SUMS-windows.txt");
    expect(localWindowsVerification).toContain("Get-FileHash -Algorithm SHA256");
  });
});
