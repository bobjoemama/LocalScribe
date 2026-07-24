import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  version: string;
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

function evaluateGeneratorModule(source: string): string {
  const moduleUrl = pathToFileURL(
    resolve(root, "scripts/generate-runtime-sbom.mjs"),
  ).href;
  return execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import * as sbom from ${JSON.stringify(moduleUrl)};\n${source}`,
    ],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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

      expectOneExactComponent(bom, expectedHelper, packageJson.version);
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

  it("is byte-for-byte deterministic for each platform graph", () => {
    expect(runtimeSbomOutput("macos")).toBe(runtimeSbomOutput("macos"));
    expect(runtimeSbomOutput("windows")).toBe(runtimeSbomOutput("windows"));
  });

  it("fails closed on missing, ranged, malformed, or inconsistent runtime versions", () => {
    for (const invalidVersion of [undefined, "", "^43.2.0", "43.2", "043.2.0"]) {
      expect(() =>
        evaluateGeneratorModule(
          `sbom.exactVersion(${JSON.stringify(invalidVersion)}, "fixture");`,
        ),
      ).toThrow(/must be an exact semantic version/u);
    }

    const validMetadata = {
      packageJson: {
        version: "0.1.0",
        devDependencies: { electron: "43.2.0" },
      },
      packageLock: {
        packages: {
          "": { devDependencies: { electron: "43.2.0" } },
          "node_modules/electron": { version: "43.2.0" },
        },
      },
      macRuntimeScript: 'python_version="3.12.13"',
      windowsRuntimeScript: '$PythonVersion = "3.12.13"',
    };
    expect(
      JSON.parse(
        evaluateGeneratorModule(
          `process.stdout.write(JSON.stringify(sbom.resolveRuntimeVersions(${JSON.stringify(validMetadata)})));`,
        ),
      ),
    ).toEqual({ app: "0.1.0", electron: "43.2.0", python: "3.12.13" });

    for (const inconsistentMetadata of [
      {
        ...validMetadata,
        packageLock: {
          packages: {
            "": { devDependencies: { electron: "43.2.0" } },
            "node_modules/electron": { version: "43.2.1" },
          },
        },
      },
      {
        ...validMetadata,
        windowsRuntimeScript: '$PythonVersion = "3.12.12"',
      },
    ]) {
      expect(() =>
        evaluateGeneratorModule(
          `sbom.resolveRuntimeVersions(${JSON.stringify(inconsistentMetadata)});`,
        ),
      ).toThrow(/pins disagree/u);
    }
  });
});
