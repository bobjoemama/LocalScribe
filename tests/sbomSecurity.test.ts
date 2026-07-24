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

  it("publishes and checksums the correct SBOM pair for each platform", () => {
    const ciWorkflow = projectFile(".github/workflows/ci.yml");
    const releaseWorkflow = projectFile(".github/workflows/release.yml");

    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      expect(
        workflow.match(/npm run --silent sbom:runtime:macos/g),
      ).toHaveLength(1);
      expect(
        workflow.match(/npm run --silent sbom:runtime:windows/g),
      ).toHaveLength(1);
      expect(
        workflow.match(/npm run --silent sbom:python:macos/g),
      ).toHaveLength(1);
      expect(
        workflow.match(/npm run --silent sbom:python:windows/g),
      ).toHaveLength(1);
      expect(
        workflow.match(
          /localscribe-core-runtime-macos-sbom\.cdx\.json/g,
        ),
      ).toHaveLength(3);
      expect(
        workflow.match(
          /localscribe-core-runtime-windows-sbom\.cdx\.json/g,
        ),
      ).toHaveLength(3);
      expect(
        workflow.match(/localscribe-python-macos-sbom\.cdx\.json/g),
      ).toHaveLength(3);
      expect(
        workflow.match(/localscribe-python-windows-sbom\.cdx\.json/g),
      ).toHaveLength(3);
      expect(workflow).toContain("set -euo pipefail");
      expect(workflow).toContain(
        'if ($LASTEXITCODE -ne 0) { throw "Windows core-runtime SBOM generation failed." }',
      );
      expect(workflow).toContain(
        'if ($LASTEXITCODE -ne 0) { throw "Windows Python SBOM generation failed." }',
      );
    }
  });
});
