import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertFreshOrdinaryArtifact,
  clearWindowsMakerOutput,
} from "../scripts/windows-artifact-safety.mts";

const temporaryDirectories: string[] = [];

function temporaryProject(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "localscribe-windows-maker-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Windows maker output safety", () => {
  it("removes only the exact stale maker target and preserves siblings", () => {
    const project = temporaryProject();
    const target = path.join(project, "out", "make", "zip", "win32", "x64");
    const sibling = path.join(project, "out", "keep.txt");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "stale.zip"), "stale");
    writeFileSync(sibling, "sentinel");

    clearWindowsMakerOutput(project, "out/make/zip/win32/x64");

    expect(existsSync(target)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
  });

  it("rejects linked output parents and stale or linked artifacts", () => {
    const project = temporaryProject();
    const victim = path.join(project, "victim");
    mkdirSync(victim);
    mkdirSync(path.join(project, "out", "make", "zip", "win32"), { recursive: true });
    const linkedTarget = path.join(project, "out", "make", "zip", "win32", "x64");
    symlinkSync(victim, linkedTarget, process.platform === "win32" ? "junction" : "dir");

    expect(() =>
      clearWindowsMakerOutput(project, "out/make/zip/win32/x64")
    ).toThrow(/ordinary directory/);
    expect(existsSync(victim)).toBe(true);

    const artifact = path.join(project, "artifact.zip");
    writeFileSync(artifact, "artifact");
    const old = new Date(Date.now() - 60_000);
    utimesSync(artifact, old, old);
    expect(() => assertFreshOrdinaryArtifact(artifact, Date.now())).toThrow(/predates/);

    const linkedArtifact = path.join(project, "linked.zip");
    symlinkSync(artifact, linkedArtifact);
    expect(() => assertFreshOrdinaryArtifact(linkedArtifact, Date.now() - 60_000)).toThrow(
      /ordinary file/,
    );
  });

  it("never follows a linked out root into a victim directory", () => {
    const project = temporaryProject();
    const victim = path.join(project, "victim-root");
    mkdirSync(path.join(victim, "make", "zip", "win32", "x64"), {
      recursive: true,
    });
    const sentinel = path.join(victim, "sentinel.txt");
    writeFileSync(sentinel, "keep");
    symlinkSync(victim, path.join(project, "out"), process.platform === "win32" ? "junction" : "dir");

    expect(() =>
      clearWindowsMakerOutput(project, "out/make/zip/win32/x64")
    ).toThrow(/output root is not an ordinary directory/);
    expect(existsSync(sentinel)).toBe(true);
  });
});
