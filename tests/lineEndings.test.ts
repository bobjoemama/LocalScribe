import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const LF_TEXT_FILES = [
  ".gitattributes",
  "README.md",
  "eslint.config.mjs",
  "forge.config.ts",
  "resources/native/windows/active-target.cpp",
  "scripts/audit-npm-all.d.mts",
  "scripts/audit-npm-all.mjs",
  "src/main.ts",
] as const;

const CRLF_POWERSHELL_FILES = [
  "resources/native/windows/build.ps1",
  "scripts/verify-local-windows.ps1",
] as const;

const BINARY_FILES = [
  "resources/branding/LocalScribe.icns",
  "resources/branding/LocalScribe.ico",
  "resources/branding/LocalScribe.iconset/icon_16x16.png",
] as const;

type Attributes = Readonly<Record<string, Readonly<Record<string, string>>>>;

function gitAttributes(paths: readonly string[]): Attributes {
  const output = execFileSync(
    "git",
    ["check-attr", "-z", "--stdin", "text", "eol"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      input: `${paths.join("\0")}\0`,
    },
  );
  const fields = output.split("\0");
  fields.pop();

  const attributes: Record<string, Record<string, string>> = {};
  for (let index = 0; index < fields.length; index += 3) {
    const path = fields[index];
    const attribute = fields[index + 1];
    const value = fields[index + 2];
    if (path === undefined || attribute === undefined || value === undefined) {
      throw new Error("git check-attr returned an incomplete record");
    }
    attributes[path] ??= {};
    attributes[path][attribute] = value;
  }
  return attributes;
}

describe("repository line-ending policy", () => {
  it("keeps source, scripts, build configuration, and documentation on LF", () => {
    const attributes = gitAttributes(LF_TEXT_FILES);

    for (const path of LF_TEXT_FILES) {
      expect(attributes[path]?.text, path).toMatch(/^(?:auto|set)$/u);
      expect(attributes[path]?.eol, path).toBe("lf");
    }
  });

  it("keeps PowerShell on CRLF and preserves binary files byte-for-byte", () => {
    const paths = [...CRLF_POWERSHELL_FILES, ...BINARY_FILES];
    const attributes = gitAttributes(paths);

    for (const path of CRLF_POWERSHELL_FILES) {
      expect(attributes[path], path).toEqual({ text: "set", eol: "crlf" });
    }
    for (const path of BINARY_FILES) {
      expect(attributes[path], path).toEqual({
        text: "unset",
        eol: "unspecified",
      });
    }
  });
});
