import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const actualVersion = execFileSync(npmExecutable, ["--version"], {
  encoding: "utf8",
}).trim();

if (actualVersion !== expectedVersion) {
  throw new Error(
    `npm version mismatch: expected ${expectedVersion}, received ${actualVersion}.`,
  );
}

process.stdout.write(`Verified npm ${actualVersion}.\n`);
