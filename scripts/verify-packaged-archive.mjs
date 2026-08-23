#!/usr/bin/env node

import path from "node:path";
import { assertPackagedArchive } from "./package-provenance.mts";

const [asarArgument, platformArgument, archArgument] = process.argv.slice(2);
if (!asarArgument || !platformArgument || !archArgument) {
  throw new Error(
    "Usage: node scripts/verify-packaged-archive.mjs <app.asar> darwin arm64",
  );
}
if (platformArgument !== "darwin") {
  throw new Error(`Unsupported packaged archive platform: ${platformArgument}`);
}

const provenance = assertPackagedArchive({
  asarPath: path.resolve(asarArgument),
  platform: platformArgument,
  arch: archArgument,
});
console.log(
  `Packaged archive verified for ${provenance.productName} ${provenance.version} ` +
    `${provenance.platform}/${provenance.arch}; source root ${provenance.sourceRoot}.`,
);
