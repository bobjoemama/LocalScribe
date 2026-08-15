import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { modelArtifactDirectory } from "../src/main/modelOperations";
import { modelSpecSchema, verifyModelDirectory } from "../src/main/modelSpec";

/*
 * `storageDirectory` and `revision` are manifest-supplied strings that become
 * real filesystem paths — `path.join(modelRoot, model.storageDirectory)` in
 * three places in modelSpec.ts and `path.resolve` in modelOperations.ts — so
 * their schema regexes are the guard, not a formatting preference.
 *
 * Mutation testing found that guard undefended: replacing either regex with a
 * bare `z.string()`, or `.strict()` with `.passthrough()`, left the whole suite
 * green. The existing traversal coverage drives its values through `modelId`,
 * which is a Hugging Face repository ID and never a path.
 *
 * Each test below therefore does two things: reject the value, and show where
 * it would have gone if the schema had not.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function modelRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "localscribe-model-guard-"));
  roots.push(root);
  return root;
}

const BASE = {
  schemaVersion: 1,
  familyId: "whisper-large-v3",
  artifactId: "test-artifact",
  platform: "darwin-arm64",
  backend: "MLX Whisper",
  displayName: "Test model",
  modelId: "trusted-owner/trusted-model",
  storageDirectory: "test-model",
  revision: "a".repeat(40),
  license: "MIT",
  files: { "weights.npz": { bytes: 1, sha256: "b".repeat(64) } },
} as const;

/** The values that would leave the app-owned model root if they got through. */
const ESCAPING_DIRECTORIES = [
  "../outside",
  "..",
  "../../../../etc",
  "nested/../../outside",
  "/absolute",
  "/etc/passwd",
  "~/Library",
  "sub/dir",
  ".",
  "",
  ".hidden",
  "-leading-dash",
  "with space",
  "Uppercase",
  "unicodeé",
  "trailing/",
  "null\0byte",
] as const;

describe("the storage directory a manifest may name", () => {
  it("rejects every value that would leave the model root", () => {
    for (const storageDirectory of ESCAPING_DIRECTORIES) {
      expect(
        () => modelSpecSchema.parse({ ...BASE, storageDirectory }),
        `storageDirectory ${JSON.stringify(storageDirectory)} was accepted`,
      ).toThrow();
    }
  });

  it("still accepts the shapes the shipped manifests use", () => {
    for (const storageDirectory of [
      "whisper-large-v3-mlx",
      "qwen3-asr-0-6b-mlx-8bit",
      "model.v2",
      "m",
      "0",
    ]) {
      expect(modelSpecSchema.parse({ ...BASE, storageDirectory }).storageDirectory)
        .toBe(storageDirectory);
    }
  });

  /*
   * Where the rejected value would have gone. `modelArtifactDirectory` has its
   * own escape check, so a traversal is caught twice — but `verifyModelDirectory`
   * and its two siblings use a bare `path.join`, and that is the path the schema
   * is the only guard on.
   */
  it("shows what a traversal would reach if the schema allowed it", async () => {
    const root = await modelRoot();
    const escaping = { ...BASE, storageDirectory: "../outside" };

    // Bypassing the schema on purpose: this is the state the regex prevents.
    const joined = path.join(root, escaping.storageDirectory);
    expect(joined.startsWith(root)).toBe(false);

    // And the one caller that re-checks does reject it, so the two guards
    // disagree about nothing.
    expect(() => modelArtifactDirectory(root, escaping as never))
      .toThrow(/escapes the app-owned model root/u);
  });

  it("treats a directory that resolves back to the root itself as an escape", async () => {
    const root = await modelRoot();

    expect(() => modelArtifactDirectory(root, { ...BASE, storageDirectory: "." } as never))
      .toThrow(/escapes the app-owned model root/u);
  });

  it("verifies nothing outside the root when the manifest is well-formed", async () => {
    const root = await modelRoot();

    const verification = await verifyModelDirectory(root, modelSpecSchema.parse(BASE));

    // Missing rather than verified: the point is that it looked inside the
    // root and found nothing, not that it followed the name somewhere else.
    expect(verification.verificationStatus).toBe("missing");
  });
});

describe("the revision a manifest may pin", () => {
  /*
   * A revision is a git commit SHA that is sent to the worker and used to pin
   * the download. Anything that is not 40 hex characters is either a mutable
   * ref — which defeats pinning entirely — or an injection into whatever
   * consumes it.
   */
  it("rejects anything that is not a full commit SHA", () => {
    for (const revision of [
      "main",
      "refs/heads/main",
      "HEAD",
      "a".repeat(39),
      "a".repeat(41),
      "A".repeat(40),
      `${"a".repeat(39)}g`,
      "../../etc/passwd",
      "",
      `${"a".repeat(40)}\n${"b".repeat(40)}`,
    ]) {
      expect(
        () => modelSpecSchema.parse({ ...BASE, revision }),
        `revision ${JSON.stringify(revision)} was accepted`,
      ).toThrow();
    }
  });

  it("accepts a real commit SHA", () => {
    const revision = "0123456789abcdef0123456789abcdef01234567";

    expect(modelSpecSchema.parse({ ...BASE, revision }).revision).toBe(revision);
  });
});

describe("fields a manifest may not invent", () => {
  /*
   * `.strict()` is what stops a manifest from carrying a key this code does not
   * know about. Without it an unknown field is silently dropped, and a manifest
   * that looks like it configures something ships believing it does.
   */
  it("rejects an unknown top-level key rather than ignoring it", () => {
    expect(() => modelSpecSchema.parse({ ...BASE, downloadUrl: "https://untrusted.invalid/x" }))
      .toThrow();
    expect(() => modelSpecSchema.parse({ ...BASE, storage_directory: "../outside" }))
      .toThrow();
    expect(() => modelSpecSchema.parse({ ...BASE, extra: 1 })).toThrow();
  });

  it("rejects an unknown key inside a file entry", () => {
    expect(() => modelSpecSchema.parse({
      ...BASE,
      files: { "weights.npz": { bytes: 1, sha256: "b".repeat(64), url: "https://untrusted.invalid" } },
    })).toThrow();
  });

  it("allows normalized nested CoreML paths but rejects paths that can escape or alias", () => {
    expect(modelSpecSchema.parse({
      ...BASE,
      files: { "bundle.mlmodelc/weights/weight.bin": { bytes: 1, sha256: "b".repeat(64) } },
    }).files).toHaveProperty("bundle.mlmodelc/weights/weight.bin");
    for (const filename of ["../escape.npz", "sub/../dir.npz", "sub//dir.npz", "sub\\dir.npz", "/absolute.npz", ".", ""]) {
      expect(
        () => modelSpecSchema.parse({ ...BASE, files: { [filename]: { bytes: 1, sha256: "b".repeat(64) } } }),
        `file name ${JSON.stringify(filename)} was accepted`,
      ).toThrow();
    }
  });
});
