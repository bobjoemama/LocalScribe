import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());
const REQUIRE_BUNDLED_CPYTHON =
  process.env["LOCALSCRIBE_REQUIRE_BUNDLED_CPYTHON"] === "1";

type CycloneDxComponent = {
  name?: unknown;
  version?: unknown;
  "bom-ref"?: unknown;
  licenses?: unknown;
  properties?: unknown;
};

type CycloneDxBom = {
  bomFormat?: unknown;
  specVersion?: unknown;
  components?: unknown;
  dependencies?: unknown;
};

type CycloneDxDependency = {
  ref?: unknown;
  dependsOn?: unknown;
};

type PackageJson = {
  version: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const packageJson = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
) as PackageJson;

const projectFile = (relativePath: string): string =>
  readFileSync(resolve(root, relativePath), "utf8");

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
  const command = REQUIRE_BUNDLED_CPYTHON
    ? "sbom:runtime:macos:candidate"
    : "sbom:runtime:macos";
  const candidateArguments = REQUIRE_BUNDLED_CPYTHON
    ? ["--", "--app", resolve(root, "out/LocalScribe-darwin-arm64/LocalScribe.app")]
    : [];
  return execFileSync(process.execPath, [
    npmExecPath,
    "run",
    "--silent",
    command,
    ...candidateArguments,
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

function componentProperty(component: CycloneDxComponent, name: string): unknown {
  if (!Array.isArray(component.properties)) return undefined;
  return (component.properties as Array<{ name?: unknown; value?: unknown }>)
    .find((property) => property.name === name)?.value;
}

function dependencies(bom: CycloneDxBom): CycloneDxDependency[] {
  expect(bom.dependencies).toBeInstanceOf(Array);
  return bom.dependencies as CycloneDxDependency[];
}

describe("runtime core SBOM generation", () => {
  it("emits a complete Apple Silicon macOS runtime graph", () => {
      const bom = runtimeSbom();
      const expectedHelper = "native/macos/active-target";
      const fluidAudioHelper = "native/macos/localscribe-fluidaudio-parakeet";
      const fluidAudioRevision = "19600a485baa4998812e4654b70d2bab8f2c9949";
      const fluidAudioReference = `fluidaudio@0.15.5+${fluidAudioRevision}`;
      const fastClusterReference = `fastcluster@embedded-in-fluidaudio-${fluidAudioRevision}`;
      const vbxReference = `vbx@embedded-in-fluidaudio-${fluidAudioRevision}`;

      expectOneExactComponent(
        bom,
        "electron",
        requiredPackageVersion(packageJson.devDependencies, "electron"),
      );
      expectOneExactComponent(bom, "CPython", "3.12.13");

      expectOneExactComponent(bom, expectedHelper, packageJson.version);
      expectOneExactComponent(bom, fluidAudioHelper, packageJson.version);
      expect(namedComponents(bom, "CrispASR")).toHaveLength(0);
      expectOneExactComponent(bom, "FluidAudio", "0.15.5");
      const fluidAudio = namedComponents(bom, "FluidAudio")[0];
      if (!fluidAudio) {
        throw new Error("runtime SBOM is missing FluidAudio");
      }
      expect(fluidAudio["bom-ref"]).toBe(fluidAudioReference);
      expect(fluidAudio.licenses).toEqual([{ license: { id: "Apache-2.0" } }]);
      expect(fluidAudio.properties).toContainEqual({
        name: "com.localscribe.runtime-role",
        value: "statically-linked-speech-runtime",
      });

      const fastCluster = namedComponents(bom, "FastCluster")[0];
      const vbx = namedComponents(bom, "VBx")[0];
      expect(fastCluster).toBeDefined();
      expect(vbx).toBeDefined();
      if (!fastCluster || !vbx) {
        throw new Error("runtime SBOM is missing embedded FluidAudio components");
      }
      expect(fastCluster).not.toHaveProperty("version");
      expect(vbx).not.toHaveProperty("version");
      expect(fastCluster).toMatchObject({
        "bom-ref": fastClusterReference,
        licenses: [{ license: { id: "BSD-2-Clause" } }],
      });
      expect(vbx).toMatchObject({
        "bom-ref": vbxReference,
        licenses: [{ license: { id: "Apache-2.0" } }],
      });
      expect(componentProperty(fastCluster, "com.localscribe.packaged-notice-sha256")).toBe(
        "67594dbe4a7477719c8160373e7767c2c319ef966a6042f76846a18af02cde0a",
      );
      expect(componentProperty(vbx, "com.localscribe.packaged-notice-sha256")).toBe(
        "08e57fdb5187c816e937916f1e176aadb400ca76f4b3b493d69730ec8f10dd80",
      );
      expect(dependencies(bom)).toContainEqual({
        ref: `${fluidAudioHelper}@${packageJson.version}`,
        dependsOn: [fluidAudioReference],
      });
      expect(dependencies(bom)).toContainEqual({
        ref: fluidAudioReference,
        dependsOn: [fastClusterReference, vbxReference],
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

  it("pins one exact python-build-standalone release archive and digest", () => {
    const pin = JSON.parse(projectFile("scripts/python-build-standalone.json")) as unknown;
    expect(JSON.parse(evaluateGeneratorModule(
      `process.stdout.write(JSON.stringify(sbom.resolveCPythonPin(${JSON.stringify(pin)}, "3.12.13")));`,
    ))).toEqual({
      buildTag: "20260504",
      sha256: "dbba2cb07d0c5c1e641aefefe78c5706ff7a01e2c4d1de18e8447522af37431e",
      url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260504/cpython-3.12.13%2B20260504-aarch64-apple-darwin-install_only_stripped.tar.gz",
    });
    expect(() => evaluateGeneratorModule(
      "sbom.resolveCPythonPin({}, \"3.12.13\");",
    )).toThrow(/exactly one platform artifact/u);
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
  it("derives an exact build identity and interpreter digest from fixture bytes", async () => {
    const module = await import(
      pathToFileURL(resolve(root, "scripts/generate-runtime-sbom.mjs")).href
    ) as { bundledCPythonDistribution: (input: unknown) => unknown };
    const interpreter = Buffer.from("fixture-cpython-interpreter");
    const reads: string[] = [];

    expect(module.bundledCPythonDistribution({
      runtimeRoot: "/fixture/runtime",
      version: "3.12.13",
      readBuildTag: (buildPath: string) => {
        reads.push(buildPath);
        return "20250814\n";
      },
      readInterpreter: (interpreterPath: string) => {
        reads.push(interpreterPath);
        return interpreter;
      },
    })).toEqual({
      directory: "cpython-3.12.13-macos-aarch64-none",
      buildTag: "20250814",
      interpreterPath:
        "/fixture/runtime/cpython-3.12.13-macos-aarch64-none/bin/python3.12",
      sha256: createHash("sha256").update(interpreter).digest("hex"),
    });
    expect(reads).toEqual([
      "/fixture/runtime/cpython-3.12.13-macos-aarch64-none/BUILD",
      "/fixture/runtime/cpython-3.12.13-macos-aarch64-none/bin/python3.12",
    ]);
  });

  it.runIf(REQUIRE_BUNDLED_CPYTHON)(
    "names the exact python-build-standalone build and hashes the shipped interpreter",
    () => {
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

      const helper = namedComponents(
        bom as CycloneDxBom,
        "native/macos/localscribe-fluidaudio-parakeet",
      )[0];
      expect(helper).toBeDefined();
      const packagedHelper = resolve(
        root,
        "out/LocalScribe-darwin-arm64/LocalScribe.app/Contents/Resources/native/macos/localscribe-fluidaudio-parakeet",
      );
      expect(componentProperty(helper ?? {}, "com.localscribe.helper-sha256")).toBe(
        createHash("sha256").update(readFileSync(packagedHelper)).digest("hex"),
      );

      const digest = cpython?.hashes?.find((entry) => entry.alg === "SHA-256")?.content;
      expect(digest, "the CPython component carries no interpreter digest").toMatch(
        /^[0-9a-f]{64}$/u,
      );
      // Verified against the exact packaged interpreter, not restored source bytes.
      const interpreter = resolve(
        root,
        "out/LocalScribe-darwin-arm64/LocalScribe.app/Contents/Resources/python-runtime",
        String(distribution),
        "bin/python3.12",
      );
      expect(digest).toBe(
        createHash("sha256").update(readFileSync(interpreter)).digest("hex"),
      );
      expect(
        readFileSync(
          resolve(
            root,
            "out/LocalScribe-darwin-arm64/LocalScribe.app/Contents/Resources/python-runtime",
            String(distribution),
            "BUILD",
          ),
          "utf8",
        ).trim(),
      ).toBe(property("com.localscribe.cpython-build-tag"));
    },
  );

  it.runIf(REQUIRE_BUNDLED_CPYTHON)(
    "reconciles the Python SBOM with packaged dist-info and selected lock wheels",
    () => {
      const application = resolve(root, "out/LocalScribe-darwin-arm64/LocalScribe.app");
      const candidatePython = resolve(
        application,
        "Contents/Resources/python-runtime/venv/bin/python3",
      );
      const npmExecPath = process.env.npm_execpath;
      if (!npmExecPath) throw new Error("Python SBOM test requires npm_execpath");
      const temporaryRoot = mkdtempSync(resolve(tmpdir(), "localscribe-python-sbom-"));
      try {
        const raw = resolve(temporaryRoot, "raw.json");
        writeFileSync(raw, execFileSync(process.execPath, [
          npmExecPath,
          "run",
          "--silent",
          "sbom:python:macos",
        ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
        const reconciled = JSON.parse(execFileSync(candidatePython, [
          "-B",
          resolve(root, "scripts/reconcile-python-sbom.py"),
          "--app",
          application,
          "--lock",
          resolve(root, "worker/uv.lock"),
          "--sbom",
          raw,
        ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as {
          components: Array<{
            hashes?: unknown[];
            properties?: Array<{ name?: string; value?: string }>;
          }>;
          metadata: { properties?: Array<{ name?: string; value?: string }> };
        };
        const inventoryCount = Number(reconciled.metadata.properties?.find(
          (property) => property.name === "com.localscribe.inventory-count",
        )?.value);
        expect(inventoryCount).toBe(reconciled.components.length + 1);
        for (const component of reconciled.components) {
          expect(component.hashes).toEqual([
            { alg: "SHA-256", content: expect.stringMatching(/^[a-f0-9]{64}$/u) },
          ]);
          expect(component.properties).toContainEqual({
            name: "com.localscribe.inventory-source",
            value: "packaged-dist-info",
          });
          expect(component.properties).toContainEqual({
            name: "com.localscribe.selected-wheel",
            value: expect.stringMatching(/\.whl$/u),
          });
        }
      } finally {
        rmSync(temporaryRoot, { force: true, recursive: true });
      }
    },
  );

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

  it("hashes the exact packaged helper and interpreter rather than source bytes", async () => {
    const module = await import(
      pathToFileURL(resolve(root, "scripts/generate-runtime-sbom.mjs")).href
    ) as {
      packagedRuntimeIdentity: (input: {
        applicationPath: string;
        version: string;
        expectedBuildTag: string;
      }) => {
        cpython: { sha256: string };
        fluidAudioHelperSha256: string;
      };
    };
    const temporaryRoot = mkdtempSync(resolve(tmpdir(), "localscribe-sbom-candidate-"));
    try {
      const app = resolve(temporaryRoot, "LocalScribe.app");
      const runtime = resolve(
        app,
        "Contents/Resources/python-runtime/cpython-3.12.13-macos-aarch64-none",
      );
      const helper = resolve(
        app,
        "Contents/Resources/native/macos/localscribe-fluidaudio-parakeet",
      );
      mkdirSync(resolve(runtime, "bin"), { recursive: true });
      mkdirSync(resolve(helper, ".."), { recursive: true });
      writeFileSync(resolve(runtime, "BUILD"), "20260504\n");
      writeFileSync(resolve(runtime, "bin/python3.12"), "packaged interpreter");
      writeFileSync(helper, "packaged helper");

      expect(module.packagedRuntimeIdentity({
        applicationPath: app,
        version: "3.12.13",
        expectedBuildTag: "20260504",
      })).toEqual({
        cpython: expect.objectContaining({
          sha256: createHash("sha256").update("packaged interpreter").digest("hex"),
        }),
        fluidAudioHelperSha256: createHash("sha256").update("packaged helper").digest("hex"),
      });
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });
});
