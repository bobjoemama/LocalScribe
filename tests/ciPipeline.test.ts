import { accessSync, constants, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SOURCE_VERIFICATION_CHECKS } from "../scripts/verify-local-source.mjs";

/*
 * LocalScribe has no hosted CI on purpose (docs/RELEASING.md, and
 * `tests/buildSecurity.test.ts` asserts the workflow files stay absent). The
 * pipeline is local: `npm run ci` runs the gate suite, and `.githooks/pre-push`
 * runs it before anything reaches the remote.
 *
 * That design has one failure mode nothing else catches: a gate silently
 * dropping out. Deleting `audit:all` from the runner, renaming a script so a
 * check points at nothing, or repointing `ci` at something cheaper would all
 * leave a green suite and an unguarded push. These assert the real chain — the
 * exported check list and the real `package.json` scripts, not source text.
 */

const REPOSITORY_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

interface PackageManifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

function readScripts(): Readonly<Record<string, string>> {
  const manifestPath = path.join(REPOSITORY_ROOT, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
  const { scripts } = manifest;
  if (!scripts) throw new Error("package.json defines no scripts");
  return scripts;
}

/**
 * Follows `npm run <name>` delegation to the command that actually does the
 * work, so the test survives a harmless rename of an intermediate alias but
 * still fails if the chain stops reaching the runner. Bounded so a script that
 * refers back to itself fails loudly instead of hanging a worker.
 */
function resolveScript(scripts: Readonly<Record<string, string>>, name: string): string {
  const seen = new Set<string>();
  let current = name;
  for (let depth = 0; depth < 8; depth += 1) {
    if (seen.has(current)) throw new Error(`npm script "${name}" delegates in a cycle`);
    seen.add(current);
    const body = scripts[current];
    if (body === undefined) throw new Error(`npm script "${current}" does not exist`);
    const delegated = /^npm run (?<target>[\w:-]+)$/u.exec(body.trim())?.groups?.["target"];
    if (delegated === undefined) return body.trim();
    current = delegated;
  }
  throw new Error(`npm script "${name}" delegates too deeply`);
}

/*
 * The gates that must run before a push. Each protects something a reviewer
 * cannot see by reading a diff: pinned toolchain versions, known-vulnerable
 * dependencies, lint and type errors, and the behaviour of the app itself.
 */
const REQUIRED_GATES = [
  "toolchain:verify",
  "audit:production",
  "audit:all",
  "audit:python",
  "worker:check-locks",
  "lint:all",
  "typecheck",
] as const;

describe("local ci pipeline", () => {
  it("routes `npm run ci` to the source verification runner", () => {
    const scripts = readScripts();
    expect(resolveScript(scripts, "ci")).toBe("node scripts/verify-local-source.mjs");
  });

  it("runs every required gate", () => {
    const invoked = new Set(
      SOURCE_VERIFICATION_CHECKS.filter((check) => check[0] === "run").map((check) => check[1]),
    );
    for (const gate of REQUIRED_GATES) {
      expect(invoked, `\`npm run ci\` no longer runs ${gate}`).toContain(gate);
    }
  });

  it("runs the test suite", () => {
    const runsTests = SOURCE_VERIFICATION_CHECKS.some((check) => check[0] === "test");
    expect(runsTests, "`npm run ci` no longer runs the test suite").toBe(true);
  });

  /*
   * A check naming a script that no longer exists fails only at push time, with
   * a bare npm error, on someone else's machine.
   */
  it("names only scripts that exist", () => {
    const scripts = readScripts();
    for (const [verb, name] of SOURCE_VERIFICATION_CHECKS) {
      if (verb !== "run" || name === undefined) continue;
      expect(Object.hasOwn(scripts, name), `no npm script named "${name}"`).toBe(true);
    }
  });

  it("does not run the macOS packaging gates, which need signing and minutes", () => {
    const names = SOURCE_VERIFICATION_CHECKS.map((check) => check[1] ?? "");
    expect(names.some((name) => name.startsWith("make:"))).toBe(false);
    expect(names.some((name) => name.startsWith("smoke:packaged:"))).toBe(false);
  });
});

describe("pre-push hook", () => {
  const hookPath = path.join(REPOSITORY_ROOT, ".githooks", "pre-push");

  /*
   * git silently ignores a hook without the execute bit. A non-executable hook
   * is indistinguishable from no hook at all, which is exactly the state this
   * pipeline exists to prevent.
   */
  it("is executable", () => {
    expect(() => {
      accessSync(hookPath, constants.X_OK);
    }).not.toThrow();
  });

  it("runs the gate suite", () => {
    const hook = readFileSync(hookPath, "utf8");
    expect(hook).toMatch(/npm run (?:--silent )?ci\b/u);
  });

  it("is what `npm run hooks:install` points git at", () => {
    const scripts = readScripts();
    expect(resolveScript(scripts, "hooks:install")).toBe(
      "git config core.hooksPath .githooks",
    );
  });
});
