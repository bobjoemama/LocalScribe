import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { modelArtifactIsPresent, modelArtifactIsVerifiedNow } from "../src/main/modelSpec";
import type { ModelSpec } from "../src/main/modelSpec";

const temporaryDirectories: string[] = [];

function createModelRoot(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "localscribe-presence-"));
  temporaryDirectories.push(directory);
  const modelRoot = path.join(directory, "models");
  mkdirSync(modelRoot);
  return modelRoot;
}

const spec = {
  schemaVersion: 1,
  familyId: "qwen3-asr-0-6b",
  artifactId: "qwen3-asr-0-6b-mlx",
  platform: "darwin-arm64",
  backend: "mlx-audio",
  displayName: "Qwen3-ASR 0.6B",
  modelId: "mlx-community/qwen3-asr-0-6b-mlx",
  storageDirectory: "qwen3-asr-0-6b-mlx",
  revision: "a".repeat(40),
  license: "apache-2.0",
  files: {
    "config.json": { bytes: 4, sha256: "b".repeat(64) },
    "weights.npz": { bytes: 8, sha256: "c".repeat(64) },
  },
} as unknown as ModelSpec;

function installArtifact(modelRoot: string, sizes: Record<string, number>): string {
  const directory = path.join(modelRoot, spec.storageDirectory);
  mkdirSync(directory, { recursive: true });
  for (const [filename, bytes] of Object.entries(sizes)) {
    writeFileSync(path.join(directory, filename), Buffer.alloc(bytes));
  }
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/*
 * This probe exists so Auto tier selection can avoid drifting onto a tier whose
 * artifact was never downloaded — switching to one kills the warm worker before
 * the load discovers the artifact is missing. It is advisory only: the worker
 * still verifies pinned digests at load time.
 */
describe("advisory model artifact presence probe", () => {
  it("accepts an artifact whose every manifest file is present at its pinned size", async () => {
    const modelRoot = createModelRoot();
    installArtifact(modelRoot, { "config.json": 4, "weights.npz": 8 });
    await expect(modelArtifactIsPresent(modelRoot, spec)).resolves.toBe(true);
  });

  it("rejects an artifact that was never downloaded", async () => {
    await expect(modelArtifactIsPresent(createModelRoot(), spec)).resolves.toBe(false);
  });

  it("rejects a partially downloaded artifact", async () => {
    const modelRoot = createModelRoot();
    installArtifact(modelRoot, { "config.json": 4 });
    await expect(modelArtifactIsPresent(modelRoot, spec)).resolves.toBe(false);
  });

  it("rejects a truncated file rather than trusting the directory listing", async () => {
    const modelRoot = createModelRoot();
    installArtifact(modelRoot, { "config.json": 4, "weights.npz": 7 });
    await expect(modelArtifactIsPresent(modelRoot, spec)).resolves.toBe(false);
  });

  it("refuses to follow a symlinked artifact directory", async () => {
    const modelRoot = createModelRoot();
    const external = path.join(modelRoot, "..", "external");
    mkdirSync(external, { recursive: true });
    writeFileSync(path.join(external, "config.json"), Buffer.alloc(4));
    writeFileSync(path.join(external, "weights.npz"), Buffer.alloc(8));
    symlinkSync(external, path.join(modelRoot, spec.storageDirectory));
    await expect(modelArtifactIsPresent(modelRoot, spec)).resolves.toBe(false);
  });

  it("rejects a missing model root instead of throwing", async () => {
    const modelRoot = path.join(createModelRoot(), "absent");
    await expect(modelArtifactIsPresent(modelRoot, spec)).resolves.toBe(false);
  });

  /*
   * This test used to read "does not read file contents, so it can run on the
   * recording boundary", which documented a size-only probe as fit to gate a
   * model switch. It is not: the warm model is killed before the digest is
   * checked, so a same-sized corrupted artifact destroyed a working runtime.
   *
   * The behaviour is unchanged and still pinned — but as a WARNING about what
   * this function cannot be used for, with the safe alternative named. The
   * switch boundary is covered by tests/modelSwitchSafety.test.ts.
   */
  it("is blind to corrupted content, so it must never gate a model switch", async () => {
    const modelRoot = createModelRoot();
    const directory = installArtifact(modelRoot, { "config.json": 4, "weights.npz": 8 });
    writeFileSync(path.join(directory, "weights.npz"), Buffer.from("tampered"));

    // Same size, wrong bytes: accepted here...
    await expect(modelArtifactIsPresent(modelRoot, spec)).resolves.toBe(true);
    // ...and correctly refused by the check that actually guards the switch.
    await expect(modelArtifactIsVerifiedNow(modelRoot, spec)).resolves.toBe(false);
  });

  it("is not referenced by the recording boundary any more", () => {
    // The Auto drift guard must call the verified-identity check. This is a
    // structural assertion on purpose: it pins which of two similarly named
    // functions the dangerous call site uses.
    const main = readFileSync("src/main.ts", "utf8");
    const guard = main.slice(
      main.indexOf("next.effectiveTier !== cached.effectiveTier"),
      main.indexOf("if (next.fitsMemoryBudget)"),
    );
    expect(guard).toContain("modelArtifactIsVerifiedNow(");
    expect(guard).not.toContain("modelArtifactIsPresent(");
  });
});
