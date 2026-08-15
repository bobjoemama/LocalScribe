#!/usr/bin/env node

import { assertSquirrelArtifacts } from "./squirrel-installer-verifier.mts";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  loadReleaseMetadata,
  releaseLayout,
} from "./release-metadata.mts";
import { extractVerifiedZip } from "./safe-zip-extraction.mts";

const releaseLayout_ = releaseLayout(loadReleaseMetadata(), "win32");

const [setupPath, nupkgPath, releasesPath] = process.argv.slice(2);
if (!setupPath || !nupkgPath || !releasesPath) {
  throw new Error(
    "Usage: node scripts/verify-squirrel-artifacts.mjs " +
      "<LocalScribe-Setup.exe> <localscribe-full.nupkg> <RELEASES>",
  );
}

const result = await assertSquirrelArtifacts({
  setupPath,
  nupkgPath,
  releasesPath,
});

const temporaryRoot = mkdtempSync(
  path.join(tmpdir(), "localscribe-squirrel-package-"),
);
const resolvedTemporaryRoot = path.resolve(temporaryRoot);
const temporaryDirectory = path.resolve(tmpdir());
if (
  !resolvedTemporaryRoot.startsWith(`${temporaryDirectory}${path.sep}`) ||
  !path.basename(resolvedTemporaryRoot).startsWith("localscribe-squirrel-package-")
) {
  throw new Error(
    `Squirrel verifier created an unexpected temporary path: ${resolvedTemporaryRoot}`,
  );
}
try {
  await extractVerifiedZip(path.resolve(nupkgPath), temporaryRoot);
  const asars = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      const candidate = path.join(directory, entry);
      const metadata = lstatSync(candidate);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Squirrel package contains a link/reparse entry: ${candidate}`);
      }
      if (metadata.isDirectory()) visit(candidate);
      else if (metadata.isFile() && entry.toLowerCase() === "app.asar") asars.push(candidate);
    }
  };
  visit(temporaryRoot);
  if (asars.length !== 1 || !existsSync(asars[0])) {
    throw new Error(
      `Squirrel package must contain exactly one app.asar; found ${asars.length}.`,
    );
  }
  execFileSync(
    process.execPath,
    [
      path.resolve("scripts/verify-packaged-archive.mjs"),
      asars[0],
      "win32",
      releaseLayout_.target.arch,
    ],
    { stdio: "inherit" },
  );
} finally {
  rmSync(resolvedTemporaryRoot, { recursive: true, force: true });
}
console.log(
  `Squirrel installer verified: ${result.payloadBytes} embedded bytes contain the exact ` +
    `${result.nupkgBytes}-byte package and RELEASES file (${result.nupkgSha256}).`,
);
