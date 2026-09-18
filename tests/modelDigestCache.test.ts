import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Main hashes the curated library whenever the model screen, diagnostics, or an
 * Apply refreshes status. The library is multiple gigabytes — 6.1GB on the
 * machine this was measured on, at 2.57GB/s — so each refresh spent seconds
 * re-reading files that had not changed since the last refresh.
 *
 * `sha256File` now memoizes a digest against the file's exact identity
 * (device, inode, size, mtime, and ctime). These tests hold the two halves of
 * that: the read really is skipped when nothing changed, and any change to the
 * bytes — including a same-size in-place edit with the modification time put
 * back — still re-reads and still fails verification.
 */
const readCounter = vi.hoisted(() => ({ bytes: 0, calls: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const read = handle.read.bind(handle) as typeof handle.read;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handle.read = (async (...readArgs: any[]) => {
        const result = await (read as (...rest: unknown[]) => Promise<{ bytesRead: number }>)(...readArgs);
        readCounter.calls += 1;
        readCounter.bytes += result.bytesRead;
        return result;
      }) as typeof handle.read;
      return handle;
    },
  };
});

const { forgetVerifiedModelDigests, modelSpecSchema, verifyModelDirectory } =
  await import("../src/main/modelSpec");

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const model = modelSpecSchema.parse({
  schemaVersion: 1,
  familyId: "qwen3-asr-1-7b",
  artifactId: "digest-cache-artifact",
  platform: "darwin-arm64",
  backend: "test",
  displayName: "Digest cache model",
  modelId: "example/digest-cache",
  storageDirectory: "digest-cache-model",
  revision: "b".repeat(40),
  license: "test",
  files: {
    "weights.bin": { bytes: 11, sha256: sha256("hello world") },
  },
});

let root = "";
let weightsPath = "";

beforeEach(async () => {
  forgetVerifiedModelDigests();
  readCounter.bytes = 0;
  readCounter.calls = 0;
  root = await mkdtemp(path.join(os.tmpdir(), "localscribe-digest-cache-"));
  const directory = path.join(root, model.storageDirectory);
  await mkdir(directory);
  weightsPath = path.join(directory, "weights.bin");
  await writeFile(weightsPath, "hello world");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("model artifact digest memoization", () => {
  it("reads the artifact once and reuses the digest for later status refreshes", async () => {
    await expect(verifyModelDirectory(root, model)).resolves.toMatchObject({
      verified: true,
      verificationStatus: "verified",
    });
    const firstPass = readCounter.bytes;
    expect(firstPass).toBeGreaterThanOrEqual(11);

    for (let refresh = 0; refresh < 5; refresh += 1) {
      await expect(verifyModelDirectory(root, model)).resolves.toMatchObject({
        verified: true,
        verificationStatus: "verified",
      });
    }
    expect(readCounter.bytes).toBe(firstPass);
  });

  it("still re-reads after the cache is dropped", async () => {
    await verifyModelDirectory(root, model);
    const firstPass = readCounter.bytes;
    forgetVerifiedModelDigests();

    await expect(verifyModelDirectory(root, model)).resolves.toMatchObject({ verified: true });
    expect(readCounter.bytes).toBe(firstPass * 2);
  });

  it("re-reads and rejects a same-size edit whose modification time was put back", async () => {
    await expect(verifyModelDirectory(root, model)).resolves.toMatchObject({ verified: true });
    const afterFirstPass = readCounter.bytes;

    const stamp = new Date(2020, 0, 1, 12, 0, 0);
    await writeFile(weightsPath, "hello w0rld");
    await utimes(weightsPath, stamp, stamp);

    await expect(verifyModelDirectory(root, model)).resolves.toMatchObject({
      present: true,
      verified: false,
      verificationStatus: "invalid",
      sizeBytes: 11,
      verifiedFiles: 0,
    });
    expect(readCounter.bytes).toBeGreaterThan(afterFirstPass);
  });

  it("does not answer for a different file that reused the freed inode", async () => {
    await expect(verifyModelDirectory(root, model)).resolves.toMatchObject({ verified: true });
    await rm(weightsPath);
    await writeFile(weightsPath, "HELLO WORLD");

    await expect(verifyModelDirectory(root, model)).resolves.toMatchObject({
      verified: false,
      verificationStatus: "invalid",
    });
  });
});
