import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  forgetVerifiedModelDigests,
  isInertDirectoryMetadata,
  modelArtifactIsVerifiedNow,
  verifyModelDirectory,
  type ModelSpec,
} from "../src/main/modelSpec";

/*
 * A model directory must contain exactly its manifest's files — an extra entry
 * means something other than the curated install wrote there. That rule was
 * right in principle and, as written, too strict to survive macOS: the Finder
 * deposits a `.DS_Store` in any directory it displays, and copying through a
 * non-HFS volume or a zip leaves AppleDouble `._name` sidecars.
 *
 * The consequence was severe and silent. A model whose every pinned file was
 * digest-identical reported as *not installed*; the next dictation failed with
 * "Local speech model is not installed", and the only remedy the app offered
 * was re-downloading up to 3.4 GB. Looking at the folder broke it.
 *
 * The exemption added for that must stay narrow, so these tests pin both
 * directions: the OS entries are tolerated, and nothing else is — including a
 * sidecar for a file the manifest does not declare, and a directory or symlink
 * wearing one of the exempt names.
 */

const temporaryDirectories: string[] = [];

const CONFIG = Buffer.from('{"n":1}');
const WEIGHTS = Buffer.from("weights-payload-abcdefghijklmnop");

function digest(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
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
    "config.json": { bytes: CONFIG.length, sha256: digest(CONFIG) },
    "weights.npz": { bytes: WEIGHTS.length, sha256: digest(WEIGHTS) },
  },
} as unknown as ModelSpec;

function installArtifact(): { modelRoot: string; directory: string } {
  const container = mkdtempSync(path.join(tmpdir(), "localscribe-metadata-"));
  temporaryDirectories.push(container);
  const modelRoot = path.join(container, "models");
  const directory = path.join(modelRoot, spec.storageDirectory);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "config.json"), CONFIG);
  writeFileSync(path.join(directory, "weights.npz"), WEIGHTS);
  return { modelRoot, directory };
}

beforeEach(() => {
  forgetVerifiedModelDigests();
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("OS metadata does not invalidate a byte-perfect model", () => {
  it.each([".DS_Store", ".localized", "._weights.npz", "._config.json"])(
    "still verifies with a %s alongside the artifact",
    async (name) => {
      const { modelRoot, directory } = installArtifact();
      writeFileSync(path.join(directory, name), Buffer.from([0, 1, 2]));

      const verification = await verifyModelDirectory(modelRoot, spec);
      expect(verification.verified).toBe(true);
      expect(verification.verificationStatus).toBe("verified");
      // The tolerated entry is not part of the artifact, so it must not be
      // counted into the size the UI reports either.
      expect(verification.sizeBytes).toBe(CONFIG.length + WEIGHTS.length);
    },
  );

  it("still lets a verified model be switched to", async () => {
    const { modelRoot, directory } = installArtifact();
    await verifyModelDirectory(modelRoot, spec);
    expect(await modelArtifactIsVerifiedNow(modelRoot, spec)).toBe(true);

    // The Finder visit happens after the verification, which is the realistic
    // ordering: the model worked, the user looked at the folder, and every
    // later switch was refused.
    writeFileSync(path.join(directory, ".DS_Store"), Buffer.from([0]));
    expect(await modelArtifactIsVerifiedNow(modelRoot, spec)).toBe(true);
  });

  it("tolerates several at once", async () => {
    const { modelRoot, directory } = installArtifact();
    for (const name of [".DS_Store", ".localized", "._config.json", "._weights.npz"]) {
      writeFileSync(path.join(directory, name), Buffer.from([0]));
    }
    await expect(verifyModelDirectory(modelRoot, spec)).resolves.toMatchObject({ verified: true });
  });
});

describe("the exemption is not a way in", () => {
  it("rejects an AppleDouble sidecar for a file the manifest does not declare", async () => {
    const { modelRoot, directory } = installArtifact();
    writeFileSync(path.join(directory, "._payload.bin"), Buffer.from("x"));

    await expect(verifyModelDirectory(modelRoot, spec)).resolves.toMatchObject({
      verified: false,
      verificationStatus: "invalid",
    });
  });

  it("rejects a directory wearing an exempt name", async () => {
    const { modelRoot, directory } = installArtifact();
    // The Finder writes a file. A directory here is someone else's doing, and
    // it could hold anything.
    mkdirSync(path.join(directory, ".DS_Store"));

    await expect(verifyModelDirectory(modelRoot, spec)).resolves.toMatchObject({ verified: false });
  });

  it("rejects a symlink wearing an exempt name", async () => {
    const { modelRoot, directory } = installArtifact();
    const outside = path.join(modelRoot, "..", "outside");
    writeFileSync(outside, Buffer.from("x"));
    symlinkSync(outside, path.join(directory, ".DS_Store"));

    await expect(verifyModelDirectory(modelRoot, spec)).resolves.toMatchObject({ verified: false });
  });

  it("still rejects an ordinary extra file", async () => {
    const { modelRoot, directory } = installArtifact();
    writeFileSync(path.join(directory, "unexpected.bin"), Buffer.from("x"));

    await expect(verifyModelDirectory(modelRoot, spec)).resolves.toMatchObject({ verified: false });
  });

  it("does not let an exempt entry stand in for a missing manifest file", async () => {
    const { modelRoot, directory } = installArtifact();
    rmSync(path.join(directory, "weights.npz"));
    writeFileSync(path.join(directory, ".DS_Store"), Buffer.from("x"));

    await expect(verifyModelDirectory(modelRoot, spec)).resolves.toMatchObject({ verified: false });
  });

  it("does not stop the digest check from rejecting corrupted content", async () => {
    const { modelRoot, directory } = installArtifact();
    const corrupted = Buffer.from(WEIGHTS);
    corrupted.writeUInt8(corrupted.readUInt8(0) ^ 0xff, 0);
    writeFileSync(path.join(directory, "weights.npz"), corrupted);
    writeFileSync(path.join(directory, ".DS_Store"), Buffer.from("x"));

    await expect(verifyModelDirectory(modelRoot, spec)).resolves.toMatchObject({ verified: false });
  });
});

/*
 * The rule is enforced twice, in two languages: main gates the switch, and the
 * Python worker gates the load. If they disagree, one of them re-introduces the
 * defect — main would happily switch to an artifact the worker then refuses as
 * `model_not_installed`, or the worker would load something main rejected.
 *
 * This runs the real Python predicate rather than reading its source.
 */
describe("both implementations agree", () => {
  const cases: Array<[string, boolean]> = [
    [".DS_Store", true],
    [".localized", true],
    ["._weights.npz", true],
    ["._config.json", true],
    ["._payload.bin", false],
    ["unexpected.bin", false],
    [".cache", false],
    ["DS_Store", false],
    ["._", false],
    ["..", false],
    ["weights.npz.tmp", false],
    ["encoder/.DS_Store", true],
    ["encoder/._weights.bin", true],
    ["encoder/._config.json", false],
  ];

  it("executes the dependency-free Python policy over the same complete case table", () => {
    const expectedNames = [...Object.keys(spec.files), "encoder/weights.bin"];
    const typescriptAnswers = cases.map(([name]) =>
      isInertDirectoryMetadata(name, new Set(expectedNames))
    );
    expect(typescriptAnswers).toEqual(cases.map(([, expected]) => expected));

    const pythonAnswers = execFileSync(
      "uv",
      [
        "run",
        "--project",
        "worker",
        "--locked",
        "--only-dev",
        "python",
        "-B",
        "-c",
        [
          "import json,sys",
          "from pathlib import PurePosixPath",
          "sys.path.insert(0, 'worker')",
          "from localscribe_worker.model_metadata import is_inert_model_metadata as f",
          "cases = json.loads(sys.argv[1])",
          "expected = frozenset(json.loads(sys.argv[2]))",
          "print(json.dumps([f(PurePosixPath(name), expected) for name in cases]))",
        ].join("\n"),
        JSON.stringify(cases.map(([name]) => name)),
        JSON.stringify(expectedNames),
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      },
    ).trim();

    expect(JSON.parse(pythonAnswers)).toEqual(typescriptAnswers);
  });
});
