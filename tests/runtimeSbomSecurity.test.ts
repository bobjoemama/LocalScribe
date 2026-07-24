import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

type CycloneDxComponent = {
  name?: unknown;
  version?: unknown;
};

type CycloneDxBom = {
  bomFormat?: unknown;
  specVersion?: unknown;
  components?: unknown;
};

type PackageJson = {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const packageJson = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
) as PackageJson;

function requiredPackageVersion(
  dependencies: Record<string, string>,
  dependency: string,
): string {
  const version = dependencies[dependency];
  if (!version) {
    throw new Error(`test fixture is missing a version for ${dependency}`);
  }
  return version;
}

function runtimeSbomOutput(platform: "macos" | "windows"): string {
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) {
    throw new Error("runtime SBOM test requires npm_execpath");
  }
  return execFileSync(process.execPath, [
    npmExecPath,
    "run",
    "--silent",
    `sbom:runtime:${platform}`,
  ], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runtimeSbom(platform: "macos" | "windows"): CycloneDxBom {
  return JSON.parse(runtimeSbomOutput(platform)) as CycloneDxBom;
}

function components(bom: CycloneDxBom): CycloneDxComponent[] {
  expect(bom.bomFormat).toBe("CycloneDX");
  expect(bom.specVersion).toMatch(/^1\.[5-9]$/u);
  expect(bom.components).toBeInstanceOf(Array);
  return bom.components as CycloneDxComponent[];
}

function namedComponents(bom: CycloneDxBom, name: string): CycloneDxComponent[] {
  return components(bom).filter((component) => component.name === name);
}

function expectOneExactComponent(
  bom: CycloneDxBom,
  name: string,
  version: string,
): void {
  const matches = namedComponents(bom, name);
  expect(matches).toHaveLength(1);
  expect(matches[0]).toMatchObject({ name, version });
}

describe("runtime core SBOM generation", () => {
  it.each([
    ["macos", "native/macos/active-target", "native/windows/active-target.exe"],
    ["windows", "native/windows/active-target.exe", "native/macos/active-target"],
  ] as const)(
    "emits a complete, platform-specific runtime graph for %s",
    (platform, expectedHelper, wrongPlatformHelper) => {
      const bom = runtimeSbom(platform);

      expectOneExactComponent(
        bom,
        "electron",
        requiredPackageVersion(packageJson.devDependencies, "electron"),
      );
      expectOneExactComponent(bom, "CPython", "3.12.13");

      expect(namedComponents(bom, expectedHelper)).toHaveLength(1);
      expect(namedComponents(bom, wrongPlatformHelper)).toHaveLength(0);

      for (const [productionDependency, version] of Object.entries(
        packageJson.dependencies,
      )) {
        expectOneExactComponent(
          bom,
          productionDependency,
          version,
        );
      }

      for (const developmentOnlyTool of Object.keys(packageJson.devDependencies).filter(
        (dependency) => dependency !== "electron",
      )) {
        expect(namedComponents(bom, developmentOnlyTool)).toHaveLength(0);
      }
    },
  );

  it("is deterministic when the same platform graph is generated twice", () => {
    expect(runtimeSbomOutput("macos")).toBe(runtimeSbomOutput("macos"));
    expect(runtimeSbomOutput("windows")).toBe(runtimeSbomOutput("windows"));
  });
});
