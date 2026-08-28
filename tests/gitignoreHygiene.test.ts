import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const gitignore = readFileSync(path.join(root, ".gitignore"), "utf8");

function isIgnored(candidate: string): boolean {
  return spawnSync("git", ["check-ignore", "--quiet", "--no-index", candidate], {
    cwd: root,
    stdio: "ignore",
  }).status === 0;
}

describe("repository ignore hygiene", () => {
  it("excludes dependencies, local environments, secrets, and generated releases", () => {
    for (const candidate of [
      "node_modules/react/index.js",
      ".env",
      ".env.production",
      "developer.env",
      ".direnv/cache",
      ".venv/bin/python",
      "out/LocalScribe.app/Contents/Info.plist",
      "LocalScribe-test-arm64.dmg",
      "LocalScribe-test-arm64.zip",
      "LocalScribe-test-SHA256SUMS.txt",
    ]) {
      expect(isIgnored(candidate), `${candidate} should be ignored`).toBe(true);
    }
  });

  it("allows a sanitized environment template to be committed", () => {
    expect(gitignore).toContain("!.env.example");
    expect(isIgnored(".env.example")).toBe(false);
  });
});
