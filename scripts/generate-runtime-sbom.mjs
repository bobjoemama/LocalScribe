#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const platformArgumentIndex = process.argv.indexOf("--platform");
const platform = platformArgumentIndex >= 0 ? process.argv[platformArgumentIndex + 1] : undefined;

if (platform !== "darwin" && platform !== "win32") {
  throw new Error("Runtime SBOM generation requires --platform darwin or --platform win32.");
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(projectRoot, relativePath), "utf8"));
}

function exactVersion(value, label) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`Runtime SBOM requires an exact ${label} version.`);
  }
  return value;
}

function captureVersion(source, pattern, label) {
  const match = source.match(pattern);
  if (!match?.[1]) throw new Error(`Runtime SBOM could not find the pinned ${label} version.`);
  return exactVersion(match[1], label);
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

const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const electronDeclared = exactVersion(packageJson.devDependencies?.electron, "Electron");
const electronLocked = exactVersion(
  packageLock.packages?.["node_modules/electron"]?.version,
  "locked Electron",
);
if (electronDeclared !== electronLocked) {
  throw new Error("Runtime SBOM rejected mismatched declared and locked Electron versions.");
}

const macRuntimeScript = readFileSync(
  path.join(projectRoot, "scripts/build-worker-runtime.sh"),
  "utf8",
);
const windowsRuntimeScript = readFileSync(
  path.join(projectRoot, "scripts/build-worker-runtime.ps1"),
  "utf8",
);
const macPython = captureVersion(
  macRuntimeScript,
  /^python_version="([^"]+)"$/mu,
  "macOS CPython",
);
const windowsPython = captureVersion(
  windowsRuntimeScript,
  /^\$PythonVersion = "([^"]+)"$/mu,
  "Windows CPython",
);
if (macPython !== windowsPython) {
  throw new Error("Runtime SBOM rejected platform CPython version drift.");
}

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

const appVersion = exactVersion(packageJson.version, "LocalScribe");
const platformName = platform === "darwin" ? "macos-arm64" : "windows-x64";
const helperName = platform === "darwin"
  ? "native/macos/active-target"
  : "native/windows/active-target.exe";
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
    type: "platform",
    "bom-ref": `cpython@${macPython}`,
    name: "CPython",
    version: macPython,
    purl: `pkg:generic/cpython@${macPython}`,
    properties: [{ name: "com.localscribe.runtime-role", value: "worker-interpreter" }],
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

const componentsByReference = new Map();
for (const component of [...productionBom.components, ...supplementalComponents]) {
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
    ...supplementalComponents.map(componentReference),
  ]),
].sort();
for (const component of supplementalComponents) {
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
