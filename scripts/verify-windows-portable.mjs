#!/usr/bin/env node

import { assertWindowsPortableArtifact } from "./windows-portable-verifier.mts";

const [stagedDirectory, zipPath] = process.argv.slice(2);
if (!stagedDirectory || !zipPath) {
  throw new Error(
    "Usage: node scripts/verify-windows-portable.mjs <staged-directory> <portable.zip>",
  );
}

const result = await assertWindowsPortableArtifact({
  stagedDirectory,
  zipPath,
});
console.log(
  `Windows portable ZIP verified as an exact ${result.fileCount}-file copy ` +
    `of the staged package (${result.zipBytes} bytes).`,
);
