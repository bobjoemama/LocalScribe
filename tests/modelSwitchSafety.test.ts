import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import {
  forgetVerifiedModelDigests,
  modelArtifactIsVerifiedNow,
  verifyModelDirectory,
  type ModelSpec,
} from "../src/main/modelSpec";
import {
  WorkerSupervisor,
  type WorkerModelSelection,
} from "../src/main/worker/workerSupervisor";

/*
 * The invariant under test:
 *
 *   A model or tier that has not been authoritatively verified at its CURRENT
 *   file identity must never evict the model that is currently working.
 *
 * It was violated by construction. Auto re-resolves the tier at every recording
 * boundary; a different tier means `WorkerSupervisor.ensureReady`, which kills
 * the Python process *before* the new one is asked to load. Pinned digests are
 * only checked inside that load. The single guard in front of all of this
 * compared file SIZES, so a same-sized corrupted artifact walked straight
 * through it: the warm model died, the load then failed on the digest, and the
 * user lost both a working runtime and the dictation in progress.
 *
 * `modelArtifactIsVerifiedNow` answers only for artifacts that a full SHA-256
 * pass already matched, at exactly the identity they have right now. Saying
 * "no" is always safe — it keeps the working model.
 */

const temporaryDirectories: string[] = [];

const CONFIG = Buffer.from('{"n":1}');
const WEIGHTS = Buffer.from("weights-payload-abcdefghijklmnop");

function digest(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

const spec = {
  schemaVersion: 1,
  familyId: "whisper-large-v3",
  artifactId: "whisper-large-v3-mlx",
  platform: "darwin-arm64",
  backend: "mlx-whisper",
  displayName: "Whisper large-v3",
  modelId: "mlx-community/whisper-large-v3-mlx",
  storageDirectory: "whisper-large-v3-mlx",
  revision: "a".repeat(40),
  license: "apache-2.0",
  files: {
    "config.json": { bytes: CONFIG.length, sha256: digest(CONFIG) },
    "weights.npz": { bytes: WEIGHTS.length, sha256: digest(WEIGHTS) },
  },
} as unknown as ModelSpec;

function createModelRoot(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "localscribe-switch-"));
  temporaryDirectories.push(directory);
  const modelRoot = path.join(directory, "models");
  mkdirSync(modelRoot);
  return modelRoot;
}

function installGoodArtifact(modelRoot: string): string {
  const directory = path.join(modelRoot, spec.storageDirectory);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "config.json"), CONFIG);
  writeFileSync(path.join(directory, "weights.npz"), WEIGHTS);
  return directory;
}

beforeEach(() => {
  forgetVerifiedModelDigests();
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("an unverified artifact can never evict a working model", () => {
  it("refuses a target that was never verified in this process", async () => {
    const modelRoot = createModelRoot();
    installGoodArtifact(modelRoot);

    // Bytes are correct, but nothing has hashed them yet. Refusing here keeps
    // the warm model; the explicit Apply path does the full verification.
    await expect(modelArtifactIsVerifiedNow(modelRoot, spec)).resolves.toBe(false);
  });

  it("accepts a target once a full verification has attested it", async () => {
    const modelRoot = createModelRoot();
    installGoodArtifact(modelRoot);

    await expect(verifyModelDirectory(modelRoot, spec)).resolves.toMatchObject({ verified: true });
    await expect(modelArtifactIsVerifiedNow(modelRoot, spec)).resolves.toBe(true);
  });

  it("case 1: refuses a missing target", async () => {
    const modelRoot = createModelRoot();
    await expect(modelArtifactIsVerifiedNow(modelRoot, spec)).resolves.toBe(false);
  });

  it("case 2: refuses a truncated target even after a prior good verification", async () => {
    const modelRoot = createModelRoot();
    const directory = installGoodArtifact(modelRoot);
    await verifyModelDirectory(modelRoot, spec);
    expect(await modelArtifactIsVerifiedNow(modelRoot, spec)).toBe(true);

    writeFileSync(path.join(directory, "weights.npz"), WEIGHTS.subarray(0, WEIGHTS.length - 1));
    await expect(modelArtifactIsVerifiedNow(modelRoot, spec)).resolves.toBe(false);
  });

  it("case 3: refuses an artifact with an extra unexpected entry", async () => {
    const modelRoot = createModelRoot();
    const directory = installGoodArtifact(modelRoot);
    await verifyModelDirectory(modelRoot, spec);
    expect(await modelArtifactIsVerifiedNow(modelRoot, spec)).toBe(true);

    // Every manifest file is still perfect; something else wrote here too.
    writeFileSync(path.join(directory, "unexpected.bin"), Buffer.from("x"));
    await expect(modelArtifactIsVerifiedNow(modelRoot, spec)).resolves.toBe(false);
  });

  /*
   * THE REPORTED DEFECT. Same byte count, different bytes — the case a size
   * probe cannot see and the reason a working model was being destroyed.
   */
  it("case 4: refuses a same-sized corrupted target", async () => {
    const modelRoot = createModelRoot();
    const directory = installGoodArtifact(modelRoot);
    await verifyModelDirectory(modelRoot, spec);
    expect(await modelArtifactIsVerifiedNow(modelRoot, spec)).toBe(true);

    const corrupted = Buffer.from(WEIGHTS);
    corrupted.writeUInt8(corrupted.readUInt8(0) ^ 0xff, 0);
    expect(corrupted.length).toBe(WEIGHTS.length);
    writeFileSync(path.join(directory, "weights.npz"), corrupted);

    await expect(modelArtifactIsVerifiedNow(modelRoot, spec)).resolves.toBe(false);
    // And a full re-verification agrees, so the two never disagree about safety.
    await expect(verifyModelDirectory(modelRoot, spec)).resolves.toMatchObject({ verified: false });
  });

  it("case 5: refuses a target whose identity changed after verification", async () => {
    const modelRoot = createModelRoot();
    const directory = installGoodArtifact(modelRoot);
    await verifyModelDirectory(modelRoot, spec);
    expect(await modelArtifactIsVerifiedNow(modelRoot, spec)).toBe(true);

    // Rewrite byte-identical content. The bytes still match the manifest, but
    // this is no longer the file that was attested, and ctime records that.
    writeFileSync(path.join(directory, "weights.npz"), WEIGHTS);
    await expect(modelArtifactIsVerifiedNow(modelRoot, spec)).resolves.toBe(false);
  });

  it("case 5b: a backdated mtime cannot restore the attestation", async () => {
    const modelRoot = createModelRoot();
    const directory = installGoodArtifact(modelRoot);
    const weights = path.join(directory, "weights.npz");
    await verifyModelDirectory(modelRoot, spec);
    expect(await modelArtifactIsVerifiedNow(modelRoot, spec)).toBe(true);

    const corrupted = Buffer.from(WEIGHTS);
    corrupted.writeUInt8(corrupted.readUInt8(1) ^ 0xff, 1);
    writeFileSync(weights, corrupted);
    // `utimes` can move atime and mtime, but the kernel stamps ctime on the
    // write and refuses to let userspace backdate it. This is what makes the
    // identity trustworthy rather than merely convenient.
    utimesSync(weights, new Date(2000, 0, 1), new Date(2000, 0, 1));

    await expect(modelArtifactIsVerifiedNow(modelRoot, spec)).resolves.toBe(false);
  });

  it("does not accept a digest computed for a different manifest at the same path", async () => {
    const modelRoot = createModelRoot();
    installGoodArtifact(modelRoot);
    await verifyModelDirectory(modelRoot, spec);
    expect(await modelArtifactIsVerifiedNow(modelRoot, spec)).toBe(true);

    // A revision bump reuses the storage directory. The cached digest is real,
    // but it is not the digest this manifest requires.
    const otherRevision = {
      ...spec,
      files: {
        ...spec.files,
        "weights.npz": { bytes: WEIGHTS.length, sha256: "d".repeat(64) },
      },
    } as unknown as ModelSpec;
    await expect(modelArtifactIsVerifiedNow(modelRoot, otherRevision)).resolves.toBe(false);
  });
});

/*
 * Cases 6-8 drive the real `WorkerSupervisor`, because the supervisor is the
 * component that actually destroys the running model. A hand-written stand-in
 * for `ensureReadyUnlocked` would only prove that the copy in the test is
 * correct, which is the same failure mode as a source-substring assertion.
 *
 * The fake process below is a transport, not a reimplementation: it answers the
 * line-delimited JSON protocol and records that it was spawned and killed. Every
 * decision under test is made by production code.
 */
describe("the supervisor proves the target before unloading the warm model", () => {
  const spawnMock = vi.mocked(spawn);
  /** Every worker request seen this test, in order, across all processes. */
  const requests: Array<Record<string, unknown>> = [];
  /** Process lifecycle, interleaved with the requests, so ordering is testable. */
  const lifecycle: string[] = [];

  class FakeWorkerProcess extends EventEmitter {
    readonly stdout = new EventEmitter();

    readonly stderr = new EventEmitter();

    exitCode: number | null = null;

    signalCode: NodeJS.Signals | null = null;

    readonly stdin = {
      write: (line: string, callback?: (error?: Error | null) => void) => {
        const request = JSON.parse(line) as Record<string, unknown>;
        requests.push(request);
        lifecycle.push(`${String(request.type)}:${String(request.modelId ?? "")}`);
        queueMicrotask(() => {
          switch (request.type) {
            case "load_model":
              this.respond({
                type: "model_ready",
                id: request.id,
                modelId: request.modelId,
                tier: request.tier,
                computeType: request.computeType,
                loadMs: 1,
              });
              break;
            case "transcribe":
              this.respond({
                type: "final",
                id: request.id,
                text: "local result",
                language: "en",
                inferenceMs: 3,
              });
              break;
            case "shutdown":
              this.respond({ type: "shutdown", id: request.id });
              queueMicrotask(() => this.exit(0));
              break;
          }
        });
        callback?.(null);
        return true;
      },
    };

    start(): void {
      lifecycle.push("spawn");
      queueMicrotask(() => this.respond({
        type: "hello",
        protocol: 1,
        backend: "localscribe-mlx-asr",
        version: "mlx-whisper/0.4.3;mlx-audio/0.4.6",
      }));
    }

    kill(): boolean {
      lifecycle.push("kill");
      this.exit(0);
      return true;
    }

    private respond(message: unknown): void {
      this.stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`, "utf8"));
    }

    private exit(code: number): void {
      if (this.exitCode !== null) return;
      this.exitCode = code;
      this.emit("exit", code, null);
    }
  }

  const warm: WorkerModelSelection = {
    modelId: "example/warm",
    tier: "medium",
    computeType: "int8",
  };

  const target: WorkerModelSelection = {
    modelId: "example/target",
    tier: "high",
    computeType: "float16",
  };

  beforeEach(() => {
    requests.length = 0;
    lifecycle.length = 0;
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      const worker = new FakeWorkerProcess();
      worker.start();
      return worker as never;
    });
  });

  /** A supervisor with `warm` already resident, as after a normal dictation. */
  async function warmSupervisor(
    guard: (selection: WorkerModelSelection) => Promise<void>,
  ): Promise<WorkerSupervisor> {
    const supervisor = new WorkerSupervisor("/worker", "/models", "/environment");
    supervisor.setTargetLoadableGuard(guard);
    await supervisor.ensureReady(warm);
    expect(supervisor.loadedSelection()).toEqual(warm);
    requests.length = 0;
    lifecycle.length = 0;
    return supervisor;
  }

  it("case 6: a failed target never changes the active selection", async () => {
    const supervisor = await warmSupervisor(async () => {
      throw new Error("model_verification_failed");
    });

    await expect(supervisor.ensureReady(target)).rejects.toThrow(/model_verification_failed/u);

    // The warm model is still the loaded one, and the worker was never asked
    // for the unverified target.
    expect(supervisor.loadedSelection()).toEqual(warm);
    expect(lifecycle).toEqual([]);
    expect(requests).toEqual([]);
    await supervisor.shutdown();
  });

  it("case 6b: the guard runs before the unload, not after", async () => {
    let lifecycleWhenGuardRan: string[] = [];
    const supervisor = await warmSupervisor(async () => {
      lifecycleWhenGuardRan = [...lifecycle];
      throw new Error("model_verification_failed");
    });

    await expect(supervisor.ensureReady(target)).rejects.toThrow();

    // Ordering is the whole guarantee: a guard that ran after the unload would
    // report the same failure with the working model already gone.
    expect(lifecycleWhenGuardRan).toEqual([]);
    await supervisor.shutdown();
  });

  it("case 7: the warm model still transcribes after a refused switch", async () => {
    const supervisor = await warmSupervisor(async (selection) => {
      if (selection.modelId === target.modelId) throw new Error("model_not_installed");
    });

    await expect(supervisor.ensureReady(target)).rejects.toThrow(/model_not_installed/u);

    // The user's next dictation must still work, on the same warm process,
    // without a multi-gigabyte reload.
    const result = await supervisor.transcribe({
      model: warm,
      audioPath: "/models/audio.wav",
      allowedRoot: "/models",
      language: "en",
      context: "",
      durationMs: 1_000,
    });

    expect(result.text).toBe("local result");
    expect(supervisor.loadedSelection()).toEqual(warm);
    // No kill and no reload: exactly one request, the transcription itself.
    expect(lifecycle).toEqual(["transcribe:"]);
    await supervisor.shutdown();
  });

  it("case 8: a verified target switches exactly once", async () => {
    const guarded: WorkerModelSelection[] = [];
    const supervisor = await warmSupervisor(async (selection) => {
      guarded.push(selection);
    });

    await supervisor.ensureReady(target);

    expect(supervisor.loadedSelection()).toEqual(target);
    expect(guarded).toEqual([target]);
    // Guard, then the unload (a graceful shutdown request), then a fresh
    // process, then exactly one load of exactly the requested selection.
    expect(lifecycle).toEqual(["shutdown:", "spawn", `load_model:${target.modelId}`]);
    expect(requests.filter((request) => request.type === "load_model")).toHaveLength(1);

    // A second call for the same selection is a no-op, so the guard is not
    // re-run and nothing is unloaded.
    await supervisor.ensureReady(target);
    expect(guarded).toEqual([target]);
    expect(requests.filter((request) => request.type === "load_model")).toHaveLength(1);
    await supervisor.shutdown();
  });

  it("does not consult the guard when the target is already warm", async () => {
    const guarded: WorkerModelSelection[] = [];
    const supervisor = await warmSupervisor(async (selection) => {
      guarded.push(selection);
    });

    await supervisor.ensureReady({ ...warm });

    expect(guarded).toEqual([]);
    expect(lifecycle).toEqual([]);
    await supervisor.shutdown();
  });

  it("does not consult the guard when there is no warm model to lose", async () => {
    const supervisor = new WorkerSupervisor("/worker", "/models", "/environment");
    supervisor.setTargetLoadableGuard(async () => {
      throw new Error("must not run on a cold start");
    });

    // Nothing is at risk, so a cold start is not gated here; the worker's own
    // pinned-digest verification is still authoritative for the load itself.
    await expect(supervisor.ensureReady(warm)).resolves.toBeUndefined();
    expect(supervisor.loadedSelection()).toEqual(warm);
    await supervisor.shutdown();
  });

  it("keeps the guard installed across a switch", async () => {
    const guarded: WorkerModelSelection[] = [];
    const supervisor = await warmSupervisor(async (selection) => {
      guarded.push(selection);
      if (selection.modelId === warm.modelId) throw new Error("model_verification_failed");
    });

    await supervisor.ensureReady(target);
    // Switching back is gated too — a guard that only applied to the first
    // switch would leave every later one unprotected.
    await expect(supervisor.ensureReady(warm)).rejects.toThrow(/model_verification_failed/u);
    expect(supervisor.loadedSelection()).toEqual(target);
    expect(guarded).toEqual([target, warm]);
    await supervisor.shutdown();
  });
});

/*
 * The guard only protects anything if main actually installs it. This is a
 * structural assertion, and it is deliberately narrow: it pins the wiring, not
 * the behaviour, which the suites above cover by execution.
 */
describe("main installs the guard", () => {
  it("gives the supervisor a target-loadable guard that verifies the artifact", () => {
    const main = readFileSync("src/main.ts", "utf8");
    expect(main).toContain("worker.setTargetLoadableGuard(");
    const guard = main.slice(
      main.indexOf("worker.setTargetLoadableGuard("),
      main.indexOf("worker.setTargetLoadableGuard(") + 1_200,
    );
    expect(guard).toContain("verifyModelDirectory(");
  });
});
