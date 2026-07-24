import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const packageJson = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
);
const packageManager = packageJson.packageManager;

if (
  typeof packageManager !== "string" ||
  !/^npm@\d+\.\d+\.\d+$/u.test(packageManager)
) {
  throw new Error(
    "package.json packageManager must pin an exact npm version (npm@x.y.z).",
  );
}

const expectedVersion = packageManager.slice("npm@".length);
const npmExecPath = process.env.npm_execpath;
if (!npmExecPath || !isAbsolute(npmExecPath) || !existsSync(npmExecPath)) {
  throw new Error(
    "npm_execpath must identify the npm CLI that launched this verification script.",
  );
}

let searchDirectory = dirname(realpathSync(npmExecPath));
let actualVersion;
for (let depth = 0; depth < 8; depth += 1) {
  const candidate = join(searchDirectory, "package.json");
  if (existsSync(candidate)) {
    const manifest = JSON.parse(readFileSync(candidate, "utf8"));
    if (manifest.name === "npm" && typeof manifest.version === "string") {
      actualVersion = manifest.version;
      break;
    }
  }
  const parent = dirname(searchDirectory);
  if (parent === searchDirectory) break;
  searchDirectory = parent;
}

if (!actualVersion) {
  throw new Error("Unable to resolve the invoking npm package version.");
}

if (actualVersion !== expectedVersion) {
  throw new Error(
    `npm version mismatch: expected ${expectedVersion}, received ${actualVersion}.`,
  );
}

process.stdout.write(`Verified npm ${actualVersion}.\n`);
