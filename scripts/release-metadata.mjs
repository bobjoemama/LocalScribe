#!/usr/bin/env node

import {
  loadReleaseMetadata,
  releaseLayout,
} from "./release-metadata.mts";

const arguments_ = process.argv.slice(2);
const platformIndex = arguments_.indexOf("--platform");
const platform = platformIndex >= 0 ? arguments_[platformIndex + 1] : undefined;
const formatIndex = arguments_.indexOf("--format");
const format = formatIndex >= 0 ? arguments_[formatIndex + 1] : "json";
const recognized = new Set([
  "--platform",
  ...(platformIndex >= 0 && platform ? [platform] : []),
  ...(formatIndex >= 0 ? ["--format", format] : []),
]);
const unknown = arguments_.filter((argument) => !recognized.has(argument));
if (platform !== "darwin" && platform !== "win32") {
  throw new Error("Usage: release-metadata.mjs --platform <darwin|win32> [--format json|tsv]");
}
if (format !== "json" && format !== "tsv") {
  throw new Error("Release metadata format must be json or tsv.");
}
if (unknown.length > 0) {
  throw new Error(`Unknown release metadata arguments: ${unknown.join(", ")}`);
}
const metadata = loadReleaseMetadata();
const layout = releaseLayout(metadata, platform);
const output = {
  packageName: metadata.packageName,
  productName: metadata.productName,
  version: metadata.version,
  packageManager: metadata.packageManager,
  repository: metadata.repository,
  macBundleId: metadata.macBundleId,
  windowsAppUserModelId: metadata.windowsAppUserModelId,
  minimumMacOSVersion: metadata.minimumMacOSVersion,
  platform,
  arch: layout.target.arch,
  platformLabel: layout.target.label,
  tag: layout.tag,
  packageDirectory: layout.packageDirectory,
  applicationPath: layout.applicationPath,
  makerDirectory: layout.makerDirectory,
  primaryArtifactPaths: layout.primaryArtifactPaths,
  coreSbomPath: layout.coreSbomPath,
  pythonSbomPath: layout.pythonSbomPath,
  checksumPath: layout.checksumPath,
};
if (format === "json") {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} else {
  const values = [
    output.productName,
    output.version,
    output.arch,
    output.packageDirectory,
    output.applicationPath,
    output.coreSbomPath,
    output.pythonSbomPath,
    output.checksumPath,
    ...output.primaryArtifactPaths,
  ];
  if (values.some((value) => value.includes("\t") || value.includes("\n"))) {
    throw new Error("Release metadata contains a value unsafe for TSV output.");
  }
  process.stdout.write(`${values.join("\t")}\n`);
}
