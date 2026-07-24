import { existsSync } from "node:fs";
import path from "node:path";
import { extractFile } from "@electron/asar";

const asarPath = process.argv[2];
if (!asarPath) {
  throw new Error("Usage: node scripts/verify-packaged-main.mjs <absolute-or-relative-app.asar>");
}

const resolvedAsarPath = path.resolve(asarPath);
if (!existsSync(resolvedAsarPath)) {
  throw new Error(`Packaged app.asar does not exist: ${resolvedAsarPath}`);
}

const main = extractFile(resolvedAsarPath, ".vite/build/main.js").toString("utf8");
if (
  main.includes("createRequire(import.meta.url)")
  || /createRequire\)\(\{\}\.url\)/u.test(main)
  || main.includes("{}.url")
) {
  throw new Error(
    "Packaged Electron main contains an import.meta.url value erased by the CommonJS build.",
  );
}

const squirrelMarker = "electron-squirrel-startup";
const markerIndex = main.indexOf(squirrelMarker);
if (markerIndex < 0) {
  throw new Error("Packaged Electron main is missing its Squirrel lifecycle bootstrap.");
}

const bootstrapContext = main.slice(
  Math.max(0, markerIndex - 300),
  markerIndex + squirrelMarker.length + 120,
);
if (!bootstrapContext.includes("getAppPath") || !bootstrapContext.includes("package.json")) {
  throw new Error(
    "Packaged Squirrel bootstrap is not anchored to Electron's absolute application path.",
  );
}

console.log(`Packaged Electron main bootstrap verified: ${resolvedAsarPath}`);
