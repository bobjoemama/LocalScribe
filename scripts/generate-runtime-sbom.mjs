#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { RELEASE_POLICY } from "../src/shared/releasePolicy.mts";

const projectRoot = path.resolve(import.meta.dirname, "..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(projectRoot, relativePath), "utf8"));
}

export function exactVersion(value, label) {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/.test(value)
  ) {
    throw new Error(`${label} must be an exact semantic version.`);
  }
  return value;
}

function captureVersion(source, pattern, label) {
  const match = source.match(pattern);
  if (!match?.[1]) throw new Error(`Runtime SBOM could not find the pinned ${label} version.`);
  return exactVersion(match[1], label);
}

export function resolveFluidAudioDependency({ packageSwift, packageResolved }) {
  const packageMatch = packageSwift.match(
    /\.package\(\s*url:\s*"https:\/\/github\.com\/FluidInference\/FluidAudio\.git",\s*exact:\s*"([0-9]+\.[0-9]+\.[0-9]+)"\s*\)/u,
  );
  const version = packageMatch?.[1] ? exactVersion(packageMatch[1], "FluidAudio package") : null;
  if (!version) throw new Error("FluidAudio helper must pin an exact package version.");
  const resolved = JSON.parse(packageResolved);
  const pins = Array.isArray(resolved?.pins) ? resolved.pins : [];
  const pin = pins.find((candidate) => candidate?.identity === "fluidaudio");
  if (
    !pin ||
    pin.kind !== "remoteSourceControl" ||
    pin.location !== "https://github.com/FluidInference/FluidAudio.git" ||
    pin.state?.version !== version ||
    typeof pin.state?.revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(pin.state.revision)
  ) {
    throw new Error("FluidAudio helper Package.resolved does not match its exact source pin.");
  }
  return { version, revision: pin.state.revision };
}

function componentReference(component) {
  if (typeof component?.["bom-ref"] === "string" && component["bom-ref"]) {
    return component["bom-ref"];
  }
  if (typeof component?.name !== "string" || typeof component?.version !== "string") {
    throw new Error("Runtime SBOM received a component without a stable identity.");
  }
  return `${component.name}@${component.version}`;
}

/**
 * Identity of the CPython distribution actually bundled for macOS.
 *
 * The pinned version alone does not identify a build: `uv python install
 * 3.12.13` resolves to a python-build-standalone release, and two releases can
 * both call themselves 3.12.13 while shipping different binaries. The
 * distribution directory records its release tag in `BUILD`, so the SBOM can
 * name the exact build and carry a digest of the interpreter that shipped
 * instead of a bare version string.
 */
export function bundledCPythonDistribution({ runtimeRoot, version, readBuildTag, readInterpreter }) {
  const [major, minor] = version.split(".");
  const directory = `cpython-${version}-macos-aarch64-none`;
  const buildTag = readBuildTag(path.join(runtimeRoot, directory, "BUILD")).trim();
  if (!/^\d{8}$/u.test(buildTag)) {
    throw new Error(
      `Bundled CPython distribution ${directory} has no python-build-standalone release tag.`,
    );
  }
  const interpreterPath = path.join(runtimeRoot, directory, "bin", `python${major}.${minor}`);
  const digest = createHash("sha256").update(readInterpreter(interpreterPath)).digest("hex");
  return { directory, buildTag, interpreterPath, sha256: digest };
}

function npmPackageLockPath(name) {
  return `node_modules/${name}`;
}

function npmPackagePurl(name, version) {
  return `pkg:npm/${encodeURIComponent(name).replaceAll("%2F", "/")}@${version}`;
}

export function resolveRuntimeVersions({
  packageJson,
  packageLock,
  macRuntimeScript,
}) {
  const app = exactVersion(packageJson?.version, "LocalScribe");
  const electronDeclared = exactVersion(
    packageJson?.devDependencies?.electron,
    "Electron declaration",
  );
  const electronRootLock = exactVersion(
    packageLock?.packages?.[""]?.devDependencies?.electron,
    "root Electron lock",
  );
  const electron = exactVersion(
    packageLock?.packages?.["node_modules/electron"]?.version,
    "installed Electron lock",
  );
  if (electronDeclared !== electronRootLock || electronDeclared !== electron) {
    throw new Error("Electron declaration and lock pins disagree.");
  }
  const python = captureVersion(
    macRuntimeScript,
    /^python_version="([^"]+)"$/mu,
    "macOS CPython",
  );
  return { app, electron, python };
}

function main() {
const platformArgumentIndex = process.argv.indexOf("--platform");
const platform = platformArgumentIndex >= 0 ? process.argv[platformArgumentIndex + 1] : undefined;
if (platform !== "darwin") {
  throw new Error("Runtime SBOM generation requires --platform darwin.");
}
const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const runtimeVersions = resolveRuntimeVersions({
  packageJson,
  packageLock,
  macRuntimeScript: readFileSync(
    path.join(projectRoot, "scripts/build-worker-runtime.sh"),
    "utf8",
  ),
});
const npmExecPath = process.env.npm_execpath;
if (!npmExecPath || !path.isAbsolute(npmExecPath)) {
  throw new Error("Runtime SBOM must run through a pinned npm script.");
}
const productionBom = JSON.parse(execFileSync(
  process.execPath,
  [npmExecPath, "sbom", "--sbom-format", "cyclonedx", "--omit=dev"],
  {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  },
));
if (
  productionBom?.bomFormat !== "CycloneDX" ||
  typeof productionBom?.specVersion !== "string" ||
  !Array.isArray(productionBom.components) ||
  !Array.isArray(productionBom.dependencies) ||
  typeof productionBom?.metadata?.component?.["bom-ref"] !== "string"
) {
  throw new Error("Runtime SBOM rejected malformed npm CycloneDX output.");
}

delete productionBom.serialNumber;
if (productionBom.metadata && typeof productionBom.metadata === "object") {
  delete productionBom.metadata.timestamp;
}

const appVersion = runtimeVersions.app;
const electronLocked = runtimeVersions.electron;
const macPython = runtimeVersions.python;
const platformName = RELEASE_POLICY.targets[platform].label;
const fluidAudio = resolveFluidAudioDependency({
  packageSwift: readFileSync(
    path.join(projectRoot, "tools/fluidaudio-parakeet-helper/Package.swift"),
    "utf8",
  ),
  packageResolved: readFileSync(
    path.join(projectRoot, "tools/fluidaudio-parakeet-helper/Package.resolved"),
    "utf8",
  ),
});
const fluidAudioHelperPath = path.join(
  projectRoot,
  "resources/native/macos/localscribe-fluidaudio-parakeet",
);
/*
 * On macOS the bundled interpreter is a release input, so the SBOM names the
 * exact python-build-standalone build and hashes the binary that shipped. The
 * runtime is built by `npm run worker:bundle` before the package gate ever
 * asks for an SBOM; running the generator on a checkout that has not built it
 * yet still produces the version-only component rather than failing, and says
 * so by omitting the distribution properties.
 */
const cpythonDistribution = existsSync(
  path.join(projectRoot, "resources/python-runtime", `cpython-${macPython}-macos-aarch64-none`),
)
  ? bundledCPythonDistribution({
    runtimeRoot: path.join(projectRoot, "resources/python-runtime"),
    version: macPython,
    readBuildTag: (buildPath) => readFileSync(buildPath, "utf8"),
    readInterpreter: (interpreterPath) => readFileSync(interpreterPath),
  })
  : null;
const helperName = "native/macos/active-target";
const supplementalComponents = [
  {
    type: "framework",
    "bom-ref": `electron@${electronLocked}`,
    name: "electron",
    version: electronLocked,
    purl: `pkg:npm/electron@${electronLocked}`,
    properties: [{ name: "com.localscribe.runtime-role", value: "desktop-shell" }],
  },
  {
        type: "library",
        "bom-ref": `fluidaudio@${fluidAudio.version}+${fluidAudio.revision}`,
        name: "FluidAudio",
        version: fluidAudio.version,
        purl: `pkg:github/FluidInference/FluidAudio@${fluidAudio.revision}`,
        externalReferences: [{
          type: "vcs",
          url: `https://github.com/FluidInference/FluidAudio.git@${fluidAudio.revision}`,
        }],
        properties: [
          { name: "com.localscribe.runtime-role", value: "parakeet-coreml-ane-engine" },
          { name: "com.localscribe.helper-protocol", value: "1" },
          ...(existsSync(fluidAudioHelperPath)
            ? [{
                name: "com.localscribe.helper-sha256",
                value: createHash("sha256").update(readFileSync(fluidAudioHelperPath)).digest("hex"),
              }]
            : []),
        ],
  },
  {
    type: "platform",
    "bom-ref": `cpython@${macPython}`,
    name: "CPython",
    version: macPython,
    purl: `pkg:generic/cpython@${macPython}`,
    ...(cpythonDistribution
      ? {
          hashes: [{ alg: "SHA-256", content: cpythonDistribution.sha256 }],
          properties: [
            { name: "com.localscribe.runtime-role", value: "worker-interpreter" },
            {
              name: "com.localscribe.cpython-distribution",
              value: cpythonDistribution.directory,
            },
            {
              name: "com.localscribe.cpython-build-tag",
              value: cpythonDistribution.buildTag,
            },
          ],
        }
      : { properties: [{ name: "com.localscribe.runtime-role", value: "worker-interpreter" }] }),
  },
  {
    type: "application",
    "bom-ref": `${helperName}@${appVersion}`,
    name: helperName,
    version: appVersion,
    purl: `pkg:generic/localscribe-active-target@${appVersion}?platform=${platformName}`,
    properties: [{ name: "com.localscribe.runtime-role", value: "target-bound-paste-helper" }],
  },
];

// npm can mark a direct production package as `peer: true` when a development
// tool also peers on the same package. `npm sbom --omit=dev` then omits that
// shipped direct dependency. Recover only exact root production pins from the
// committed lock and fail closed if declaration and lock disagree.
const recoveredProductionComponents = Object.entries(packageJson.dependencies)
  .filter(([name, version]) =>
    !productionBom.components.some(
      (component) => component.name === name && component.version === version,
    ))
  .map(([name, declaredVersion]) => {
    const version = exactVersion(declaredVersion, `${name} declaration`);
    const lockEntry = packageLock.packages?.[npmPackageLockPath(name)];
    const lockedVersion = exactVersion(lockEntry?.version, `${name} installed lock`);
    if (version !== lockedVersion) {
      throw new Error(`${name} declaration and lock pins disagree.`);
    }
    return {
      type: "library",
      "bom-ref": `${name}@${version}`,
      name,
      version,
      scope: "required",
      purl: npmPackagePurl(name, version),
      properties: [
        {
          name: "com.localscribe.sbom-source",
          value: "root-production-dependency-recovered-from-package-lock",
        },
      ],
      ...(typeof lockEntry.license === "string"
        ? { licenses: [{ license: { id: lockEntry.license } }] }
        : {}),
    };
  });

const componentsByReference = new Map();
for (const component of [
  ...productionBom.components,
  ...recoveredProductionComponents,
  ...supplementalComponents,
]) {
  const reference = componentReference(component);
  if (componentsByReference.has(reference)) {
    throw new Error(`Runtime SBOM rejected duplicate component reference: ${reference}`);
  }
  componentsByReference.set(reference, component);
}
productionBom.components = [...componentsByReference.values()].sort((left, right) =>
  componentReference(left).localeCompare(componentReference(right)),
);

const rootReference = productionBom.metadata.component["bom-ref"];
const rootDependency = productionBom.dependencies.find((entry) => entry?.ref === rootReference);
if (!rootDependency || !Array.isArray(rootDependency.dependsOn)) {
  throw new Error("Runtime SBOM could not identify the LocalScribe dependency root.");
}
rootDependency.dependsOn = [
  ...new Set([
    ...rootDependency.dependsOn,
    ...recoveredProductionComponents.map(componentReference),
    ...supplementalComponents.map(componentReference),
  ]),
].sort();
for (const component of [...recoveredProductionComponents, ...supplementalComponents]) {
  productionBom.dependencies.push({
    ref: componentReference(component),
    dependsOn: [],
  });
}
productionBom.dependencies.sort((left, right) => String(left.ref).localeCompare(String(right.ref)));

productionBom.metadata.properties = [
  ...(Array.isArray(productionBom.metadata.properties)
    ? productionBom.metadata.properties
    : []),
  { name: "com.localscribe.platform", value: platformName },
  {
    name: "com.localscribe.scope",
    value: "shipped-core-runtime; platform Python packages are in the companion SBOM",
  },
].sort((left, right) => left.name.localeCompare(right.name));

process.stdout.write(`${JSON.stringify(productionBom, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) main();
