import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

type CycloneDxComponent = {
  name?: unknown;
  version?: unknown;
  "bom-ref"?: unknown;
  properties?: unknown;
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

function runtimeSbomOutput(): string {
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) {
    throw new Error("runtime SBOM test requires npm_execpath");
  }
  return execFileSync(process.execPath, [
    npmExecPath,
    "run",
    "--silent",
    "sbom:runtime:macos",
  ], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runtimeSbom(): CycloneDxBom {
  return JSON.parse(runtimeSbomOutput()) as CycloneDxBom;
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
  it("emits a complete Apple Silicon macOS runtime graph", () => {
      const bom = runtimeSbom();
      const expectedHelper = "native/macos/active-target";

      expectOneExactComponent(
        bom,
        "electron",
        requiredPackageVersion(packageJson.devDependencies, "electron"),
      );
      expectOneExactComponent(bom, "CPython", "3.12.13");

      expectOneExactComponent(bom, expectedHelper, packageJson.version);
      expect(namedComponents(bom, "CrispASR")).toHaveLength(0);
      expectOneExactComponent(bom, "FluidAudio", "0.15.5");
      const fluidAudio = namedComponents(bom, "FluidAudio")[0];
      if (!fluidAudio) {
        throw new Error("runtime SBOM is missing FluidAudio");
      }
      expect(fluidAudio["bom-ref"]).toBe(
        "fluidaudio@0.15.5+19600a485baa4998812e4654b70d2bab8f2c9949",
      );
      expect(fluidAudio.properties).toContainEqual({
        name: "com.localscribe.runtime-role",
        value: "parakeet-coreml-ane-engine",
      });

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
  });

  it("is byte-for-byte deterministic for each platform graph", () => {
    expect(runtimeSbomOutput()).toBe(runtimeSbomOutput());
  }, 20_000);

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
    ]) {
      expect(() =>
        evaluateGeneratorModule(
          `sbom.resolveRuntimeVersions(${JSON.stringify(inconsistentMetadata)});`,
        ),
      ).toThrow(/pins disagree/u);
    }
  });
});

/*
 * `cpython@3.12.13` does not identify a build. `uv python install 3.12.13`
 * resolves to a python-build-standalone release, and two releases can both call
 * themselves 3.12.13 while shipping different binaries — so a version-only
 * component cannot answer "which interpreter shipped in this app?" or be used
 * to check one. The macOS component carries the release tag and a digest of the
 * interpreter that was actually bundled.
 */
describe("bundled CPython distribution identity", () => {
  it("names the exact python-build-standalone build and hashes the shipped interpreter", () => {
    const bom = runtimeSbom() as { components?: unknown };
    const components = Array.isArray(bom.components) ? bom.components : [];
    const cpython = components.find(
      (component) => (component as { name?: unknown }).name === "CPython",
    ) as {
      hashes?: { alg?: string; content?: string }[];
      properties?: { name?: string; value?: string }[];
    } | undefined;
    expect(cpython, "the runtime SBOM has no CPython component").toBeDefined();

    const property = (name: string): string | undefined =>
      cpython?.properties?.find((entry) => entry.name === name)?.value;
    const distribution = property("com.localscribe.cpython-distribution");
    expect(distribution).toBe("cpython-3.12.13-macos-aarch64-none");
    expect(property("com.localscribe.cpython-build-tag")).toMatch(/^\d{8}$/u);

    const digest = cpython?.hashes?.find((entry) => entry.alg === "SHA-256")?.content;
    expect(digest, "the CPython component carries no interpreter digest").toMatch(
      /^[0-9a-f]{64}$/u,
    );
    // Verified against the interpreter on disk, not merely well-formed.
    const interpreter = resolve(
      root,
      "resources/python-runtime",
      String(distribution),
      "bin/python3.12",
    );
    expect(digest).toBe(
      createHash("sha256").update(readFileSync(interpreter)).digest("hex"),
    );
    expect(readFileSync(resolve(root, "resources/python-runtime", String(distribution), "BUILD"), "utf8").trim())
      .toBe(property("com.localscribe.cpython-build-tag"));
  });

  it("refuses a distribution directory with no release tag", async () => {
    const module = await import(
      pathToFileURL(resolve(root, "scripts/generate-runtime-sbom.mjs")).href
    ) as { bundledCPythonDistribution: (input: unknown) => unknown };

    expect(() => module.bundledCPythonDistribution({
      runtimeRoot: "/does-not-matter",
      version: "3.12.13",
      readBuildTag: () => "not-a-release-tag",
      readInterpreter: () => Buffer.from("interpreter"),
    })).toThrow(/no python-build-standalone release tag/u);
  });
});
