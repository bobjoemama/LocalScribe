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

const mainArchivePath = path.join(".vite", "build", "main.js");
const main = extractFile(resolvedAsarPath, mainArchivePath).toString("utf8");
if (
  main.includes("createRequire(import.meta.url)")
  || /createRequire\)\(\{\}\.url\)/u.test(main)
  || main.includes("{}.url")
) {
  throw new Error(
    "Packaged Electron main contains an import.meta.url value erased by the CommonJS build.",
  );
}

console.log(`Packaged Electron main module verified: ${resolvedAsarPath}`);
