import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("pre-push Git repository isolation", () => {
  it("keeps linked-worktree metadata intact when the gate initializes and commits foreign fixtures", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "localscribe-owned-push-"));
    // Even if a developer invokes this regression from a hook, setup and
    // inspection must never target the developer's inherited Git directory.
    const environment = { ...process.env };
    const localVariables = execFileSync("git", ["rev-parse", "--local-env-vars"], {
      encoding: "utf8",
    }).trim().split(/\s+/u);
    for (const variable of localVariables) delete environment[variable];
    const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, {
      cwd, env: environment, encoding: "utf8",
    }).trim();
    try {
      const primary = path.join(directory, "primary");
      const linked = path.join(directory, "linked");
      const remote = path.join(directory, "remote.git");
      const bin = path.join(directory, "bin");
      mkdirSync(primary);
      mkdirSync(bin);
      git(primary, "init", "--quiet");
      writeFileSync(path.join(primary, "sentinel"), "original source\n");
      git(primary, "add", "sentinel");
      git(primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "commit", "--quiet", "-m", "owned source");
      git(primary, "worktree", "add", "--quiet", "-b", "owned-linked", linked);
      git(primary, "init", "--quiet", "--bare", remote);
      const hookDirectory = path.join(primary, ".git", "hooks");
      copyFileSync(path.resolve(".githooks/pre-push"), path.join(hookDirectory, "pre-push.actual"));
      writeFileSync(path.join(hookDirectory, "pre-push"), `#!/bin/bash
printf '%s' "$GIT_DIR" > '${path.join(directory, "hook-git-dir")}'
exec '${path.join(hookDirectory, "pre-push.actual")}' "$@"
`, { mode: 0o700 });
      // The real hook invokes this owned stand-in for npm. Its Git subprocesses
      // intentionally inherit the hook child's environment, just like Vitest.
      writeFileSync(path.join(bin, "npm"), `#!${process.execPath}
const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const fixture = path.join(process.cwd(), 'foreign-fixture');
mkdirSync(fixture);
writeFileSync(path.join(fixture, 'fixture'), 'owned fixture');
const git = (...args) => execFileSync('git', args, { cwd: fixture });
git('init', '--quiet');
git('add', 'fixture');
git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'foreign fixture');
git('init', '--quiet', '--bare', path.join(fixture, 'nested-remote.git'));
`, { mode: 0o700 });
      const linkedGitDirectory = git(linked, "rev-parse", "--absolute-git-dir");
      const files = [
        path.join(primary, ".git", "config"), path.join(primary, ".git", "index"),
        path.join(primary, ".git", "HEAD"), path.join(linkedGitDirectory, "index"),
        path.join(linkedGitDirectory, "HEAD"),
      ];
      const before = files.map((filename) => readFileSync(filename));
      const refsBefore = git(primary, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");
      const linkedHead = git(linked, "rev-parse", "HEAD");
      const result = spawnSync("git", ["push", remote, "HEAD:refs/heads/submitted"], {
        cwd: linked,
        env: { ...environment, PATH: `${bin}${path.delimiter}${environment.PATH ?? ""}` },
        encoding: "utf8",
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("pre-push: gates passed.");
      expect(readFileSync(path.join(directory, "hook-git-dir"), "utf8")).toBe(linkedGitDirectory);
      expect(git(primary, "config", "--get", "core.bare")).toBe("false");
      files.forEach((filename, index) => expect(readFileSync(filename)).toEqual(before[index]));
      expect(git(primary, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"))
        .toBe(refsBefore);
      expect(git(linked, "rev-parse", "HEAD")).toBe(linkedHead);
      expect(git(remote, "rev-parse", "refs/heads/submitted")).toBe(linkedHead);
      expect(readFileSync(path.join(linked, "sentinel"), "utf8")).toBe("original source\n");
    } finally {
      // Only this test's private repositories are removed.
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
