import { readFileSync } from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

/*
 * `.gitignore` and `eslint.config.mjs` both have to know what the build writes,
 * and nothing kept them in step. They drifted: `make:mac` bundles the main
 * process to `/main.js`, `.gitignore` knew about it, ESLint did not, and so
 * `npm run lint` reported 41 errors against minified output for anyone who
 * linted after building. The failure was invisible on a clean checkout, which
 * is why it survived.
 *
 * This asks ESLint's own resolver whether it would lint a file under each of
 * those paths, rather than reading the config as text. A substring assertion
 * would pass against a config whose ignore list had been reordered into
 * something ESLint no longer honours.
 */
const projectRoot = path.resolve(__dirname, "..");
const BUILD_OUTPUT_SECTION = "# JavaScript build and dependency output";

/* Entries that cannot contain a file ESLint would ever be asked to lint. */
const NOT_A_LINT_TARGET = /^\*\./u;

function buildOutputPaths(): readonly string[] {
  const gitignore = readFileSync(path.join(projectRoot, ".gitignore"), "utf8");
  const lines = gitignore.split("\n");
  const start = lines.indexOf(BUILD_OUTPUT_SECTION);
  if (start === -1) {
    throw new Error(
      `.gitignore no longer has a "${BUILD_OUTPUT_SECTION}" section; this test ` +
      "cannot tell which paths are build output without it",
    );
  }

  const entries: string[] = [];
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (line === "") break; // the section ends at the first blank line
    if (line.startsWith("#") || NOT_A_LINT_TARGET.test(line)) continue;
    entries.push(line.replace(/^\//u, ""));
  }
  return entries;
}

/* A file ESLint would want to lint, located inside (or at) the ignored path. */
function probeFor(entry: string): string {
  return entry.endsWith("/") ? `${entry}probe.js` : entry;
}

let eslint: ESLint;
let entries: readonly string[];

beforeAll(() => {
  eslint = new ESLint({ cwd: projectRoot });
  entries = buildOutputPaths();
});

describe("ESLint ignores everything the build writes", () => {
  /*
   * Without this the loop below would pass vacuously if the section were
   * renamed and parsing silently returned nothing.
   */
  it("found the build-output entries it is supposed to check", () => {
    expect(entries.length).toBeGreaterThanOrEqual(6);
    expect(entries).toContain("main.js");
    expect(entries).toContain("out/");
  });

  it("ignores a file under every gitignored build-output path", async () => {
    const linted: string[] = [];
    for (const entry of entries) {
      const probe = probeFor(entry);
      if (!(await eslint.isPathIgnored(path.join(projectRoot, probe)))) {
        linted.push(probe);
      }
    }
    expect(linted).toEqual([]);
  });

  /*
   * The counterweight: an ignore list of `["**"]` would satisfy the assertion
   * above while disabling linting entirely.
   */
  it("still lints real source", async () => {
    for (const source of ["src/main.ts", "eslint.config.mjs", "tests/pillLayout.test.ts"]) {
      expect(await eslint.isPathIgnored(path.join(projectRoot, source))).toBe(false);
    }
  });
});
