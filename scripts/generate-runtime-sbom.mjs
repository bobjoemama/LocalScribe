#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
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

export function resolveCPythonPin(downloads, expectedVersion) {
  const [expectedMajor, expectedMinor, expectedPatch] = exactVersion(
    expectedVersion,
    "expected CPython download",
  ).split(".").map(Number);
  const entries = Object.values(downloads ?? {});
  if (entries.length !== 1) {
    throw new Error("CPython download metadata must contain exactly one platform artifact.");
  }
  const pin = entries[0];
  if (
    pin?.name !== "cpython" ||
    pin?.major !== expectedMajor ||
    pin?.minor !== expectedMinor ||
    pin?.patch !== expectedPatch ||
    pin?.os !== "darwin" ||
    pin?.arch?.family !== "aarch64" ||
    !/^\d{8}$/u.test(pin?.build) ||
    !/^[a-f0-9]{64}$/u.test(pin?.sha256) ||
    typeof pin?.url !== "string" ||
    !pin.url.startsWith(
      `https://github.com/astral-sh/python-build-standalone/releases/download/${pin.build}/`,
    )
  ) {
    throw new Error("CPython download metadata is not an exact Apple Silicon release pin.");
  }
  return { buildTag: pin.build, sha256: pin.sha256, url: pin.url };
}

function ordinaryCandidateFile(filePath, candidateRoot, label) {
  const metadata = lstatSync(filePath);
  const resolved = realpathSync(filePath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (resolved !== candidateRoot && !resolved.startsWith(`${candidateRoot}${path.sep}`))
  ) {
    throw new Error(`Runtime SBOM candidate ${label} is not an ordinary in-bundle file.`);
  }
  return resolved;
}

export function packagedRuntimeIdentity({ applicationPath, version, expectedBuildTag }) {
  const application = realpathSync(applicationPath);
  if (!statSync(application).isDirectory() || !application.endsWith(".app")) {
    throw new Error("Runtime SBOM candidate must be a macOS application bundle.");
  }
  const resources = realpathSync(path.join(application, "Contents", "Resources"));
  if (resources !== application && !resources.startsWith(`${application}${path.sep}`)) {
    throw new Error("Runtime SBOM candidate Resources escaped the application bundle.");
  }
  const distribution = `cpython-${version}-macos-aarch64-none`;
  const [major, minor] = version.split(".");
  const interpreterPath = ordinaryCandidateFile(
    path.join(resources, "python-runtime", distribution, "bin", `python${major}.${minor}`),
    resources,
    "CPython interpreter",
  );
  const helperPath = ordinaryCandidateFile(
    path.join(resources, "native", "macos", "localscribe-fluidaudio-parakeet"),
    resources,
    "FluidAudio helper",
  );
  const buildTag = readFileSync(
    path.join(resources, "python-runtime", distribution, "BUILD"),
    "utf8",
  ).trim();
  if (buildTag !== expectedBuildTag) {
    throw new Error("Runtime SBOM candidate CPython release does not match its source pin.");
  }
  return {
    cpython: {
      directory: distribution,
      buildTag,
      interpreterPath,
      sha256: createHash("sha256").update(readFileSync(interpreterPath)).digest("hex"),
    },
    fluidAudioHelperSha256: createHash("sha256")
      .update(readFileSync(helperPath))
      .digest("hex"),
  };
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
const cpythonPin = resolveCPythonPin(
  readJson("scripts/python-build-standalone.json"),
  runtimeVersions.python,
);
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
const applicationIndex = process.argv.indexOf("--app");
const applicationPath = applicationIndex >= 0 ? process.argv[applicationIndex + 1] : undefined;
const sourceOnly = process.argv.includes("--source-only");
if ((applicationPath ? 1 : 0) + (sourceOnly ? 1 : 0) !== 1) {
  throw new Error("Runtime SBOM requires exactly one of --app <candidate.app> or --source-only.");
}
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
const exactNoticeDigest = (relativePath, expectedDigest, label) => {
  const digest = createHash("sha256")
    .update(readFileSync(path.join(projectRoot, relativePath)))
    .digest("hex");
  if (digest !== expectedDigest) {
    throw new Error(`${label} notice does not match the exact pinned FluidAudio source bytes.`);
  }
  return digest;
};
const fastClusterNoticeDigest = exactNoticeDigest(
  "resources/licenses/FluidAudio-0.15.5-fastcluster-LICENSE.md",
  "67594dbe4a7477719c8160373e7767c2c319ef966a6042f76846a18af02cde0a",
  "FastCluster",
);
const vbxNoticeDigest = exactNoticeDigest(
  "resources/licenses/FluidAudio-0.15.5-vbx-LICENSE.md",
  "08e57fdb5187c816e937916f1e176aadb400ca76f4b3b493d69730ec8f10dd80",
  "VBx",
);
/*
 * On macOS the bundled interpreter is a release input, so the SBOM names the
 * exact python-build-standalone build and hashes the binary that shipped. The
 * Candidate generation reads only the signed application's copy. Source-only
 * generation retains the exact source-archive pin but deliberately omits a
 * shipped-binary digest because no candidate artifact was supplied.
 */
const packagedRuntime = applicationPath
  ? packagedRuntimeIdentity({
      applicationPath,
      version: macPython,
      expectedBuildTag: cpythonPin.buildTag,
    })
  : null;
const cpythonDistribution = packagedRuntime?.cpython ?? null;
const activeTargetHelperName = "native/macos/active-target";
const fluidAudioHelperName = "native/macos/localscribe-fluidaudio-parakeet";
const fluidAudioReference = `fluidaudio@${fluidAudio.version}+${fluidAudio.revision}`;
const fluidAudioHelperReference = `${fluidAudioHelperName}@${appVersion}`;
const fastClusterReference = `fastcluster@embedded-in-fluidaudio-${fluidAudio.revision}`;
const vbxReference = `vbx@embedded-in-fluidaudio-${fluidAudio.revision}`;
const electronComponent = {
  type: "framework",
  "bom-ref": `electron@${electronLocked}`,
  name: "electron",
  version: electronLocked,
  purl: `pkg:npm/electron@${electronLocked}`,
  properties: [{ name: "com.localscribe.runtime-role", value: "desktop-shell" }],
};
const fluidAudioComponent = {
  type: "library",
  "bom-ref": fluidAudioReference,
  name: "FluidAudio",
  version: fluidAudio.version,
  purl: `pkg:github/FluidInference/FluidAudio@${fluidAudio.revision}`,
  licenses: [{ license: { id: "Apache-2.0" } }],
  externalReferences: [{
    type: "vcs",
    url: `https://github.com/FluidInference/FluidAudio.git@${fluidAudio.revision}`,
  }],
  properties: [
    { name: "com.localscribe.runtime-role", value: "statically-linked-speech-runtime" },
  ],
};
const fluidAudioEmbeddedComponents = [
  {
    type: "library",
    "bom-ref": fastClusterReference,
    name: "FastCluster",
    licenses: [{ license: { id: "BSD-2-Clause" } }],
    externalReferences: [{
      type: "vcs",
      url: "https://github.com/fastcluster/fastcluster",
    }],
    properties: [
      { name: "com.localscribe.runtime-role", value: "embedded-native-clustering-source" },
      { name: "com.localscribe.embedded-by", value: fluidAudioReference },
      {
        name: "com.localscribe.implementation-source-path",
        value: "Sources/FastClusterWrapper/fastcluster_internal.hpp",
      },
      {
        name: "com.localscribe.notice-source-path",
        value: "ThirdPartyLicenses/fastcluster-LICENSE.md",
      },
      {
        name: "com.localscribe.packaged-notice-path",
        value: "licenses/FluidAudio-0.15.5-fastcluster-LICENSE.md",
      },
      { name: "com.localscribe.packaged-notice-sha256", value: fastClusterNoticeDigest },
    ],
  },
  {
    type: "library",
    "bom-ref": vbxReference,
    name: "VBx",
    licenses: [{ license: { id: "Apache-2.0" } }],
    externalReferences: [{
      type: "vcs",
      url: "https://github.com/BUTSpeechFIT/VBx",
    }],
    properties: [
      { name: "com.localscribe.runtime-role", value: "embedded-algorithm-implementation" },
      { name: "com.localscribe.embedded-by", value: fluidAudioReference },
      {
        name: "com.localscribe.implementation-kind",
        value: "FluidAudio Swift implementation based on the upstream VBx algorithm",
      },
      {
        name: "com.localscribe.implementation-source-path",
        value: "Sources/FluidAudio/Diarizer/Offline/Clustering/VBxClustering.swift",
      },
      {
        name: "com.localscribe.notice-source-path",
        value: "ThirdPartyLicenses/vbx-LICENSE.md",
      },
      {
        name: "com.localscribe.packaged-notice-path",
        value: "licenses/FluidAudio-0.15.5-vbx-LICENSE.md",
      },
      { name: "com.localscribe.packaged-notice-sha256", value: vbxNoticeDigest },
    ],
  },
];
const rootSupplementalComponents = [
  electronComponent,
  {
    type: "application",
    "bom-ref": fluidAudioHelperReference,
    name: fluidAudioHelperName,
    version: appVersion,
    purl: `pkg:generic/localscribe-fluidaudio-parakeet@${appVersion}?platform=${platformName}`,
    properties: [
      { name: "com.localscribe.runtime-role", value: "parakeet-coreml-ane-helper" },
      { name: "com.localscribe.helper-protocol", value: "1" },
      ...(packagedRuntime
        ? [{
            name: "com.localscribe.helper-sha256",
            value: packagedRuntime.fluidAudioHelperSha256,
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
            {
              name: "com.localscribe.cpython-source-archive-sha256",
              value: cpythonPin.sha256,
            },
            {
              name: "com.localscribe.cpython-source-url",
              value: cpythonPin.url,
            },
          ],
        }
      : {
          properties: [
            { name: "com.localscribe.runtime-role", value: "worker-interpreter" },
            { name: "com.localscribe.cpython-build-tag", value: cpythonPin.buildTag },
            {
              name: "com.localscribe.cpython-source-archive-sha256",
              value: cpythonPin.sha256,
            },
            { name: "com.localscribe.cpython-source-url", value: cpythonPin.url },
          ],
        }),
  },
  {
    type: "application",
    "bom-ref": `${activeTargetHelperName}@${appVersion}`,
    name: activeTargetHelperName,
    version: appVersion,
    purl: `pkg:generic/localscribe-active-target@${appVersion}?platform=${platformName}`,
    properties: [{ name: "com.localscribe.runtime-role", value: "target-bound-paste-helper" }],
  },
];
const supplementalComponents = [
  ...rootSupplementalComponents,
  fluidAudioComponent,
  ...fluidAudioEmbeddedComponents,
];
const supplementalDependencyEdges = new Map([
  [fluidAudioHelperReference, [fluidAudioReference]],
  [fluidAudioReference, [fastClusterReference, vbxReference]],
]);

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
    ...rootSupplementalComponents.map(componentReference),
  ]),
].sort();
for (const component of [...recoveredProductionComponents, ...supplementalComponents]) {
  const reference = componentReference(component);
  productionBom.dependencies.push({
    ref: reference,
    dependsOn: supplementalDependencyEdges.get(reference) ?? [],
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
