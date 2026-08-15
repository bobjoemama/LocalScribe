import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import {
  INSTALL_MAX_ARTIFACT_BYTES,
  INSTALL_MIN_BYTES_PER_SECOND,
  MEASURED_WORST_REALTIME_FACTOR,
  TRANSCRIBE_COLD_LOAD_BUDGET_MS,
  TRANSCRIBE_REALTIME_FACTOR_BUDGET,
  TRANSCRIBE_TIMEOUT_CEILING_MS,
  WORKER_RUNTIME_IDENTITIES,
  WorkerSupervisor,
  installTimeoutMs,
  transcribeTimeoutMs,
  workerModelSelectionsMatch,
  type WorkerModelSelection,
} from "../src/main/worker/workerSupervisor";
import { AUDIO_MAX_DURATION_MS } from "../src/shared/audioProtocol";

const spawnMock = vi.mocked(spawn);
const requests: Array<Record<string, unknown>> = [];
let onWorkerRequest: ((request: Record<string, unknown>) => void) | null = null;
const temporaryDirectories: string[] = [];

describe("transcribe request budget", () => {
  /*
   * This suite exists because the budget has now been wrong twice, and the
   * second time the test agreed with the bug.
   *
   * Measured on the packaged runtime, Apple M4 Max, 600 s of continuous speech:
   * mlx-whisper large-v3 fp16 took 135.6 s and qwen3-asr-0.6b 8-bit took 10.5 s.
   *
   *   REALTIME FACTOR = inference / audio = 135.6/600 = 0.226
   *   SPEED MULTIPLE  = audio / inference = 600/135.6 = 4.43
   *
   * The production comment called 4.24 a "realtime factor" and multiplied the
   * duration by 12 to leave "margin" above it. It had multiplied by the speed
   * multiple, which inverts the margin: the ceiling became 121 minutes for a
   * ten-minute recording. The old test asserted the budget was at least
   * `AUDIO_MAX_DURATION_MS * 12` and at most three hours, so it not only failed
   * to catch the inversion, it required it.
   *
   * Every assertion below therefore computes its own units from the measured
   * seconds rather than trusting a named constant.
   */
  const MEASURED_AUDIO_MS = 600_000;
  const MEASURED_WHISPER_LARGE_V3_FP16_MS = 135_567;
  const MEASURED_QWEN_06B_INT8_MS = 10_513;

  it("distinguishes the realtime factor from the speed multiple", () => {
    const realtimeFactor = MEASURED_WHISPER_LARGE_V3_FP16_MS / MEASURED_AUDIO_MS;
    const speedMultiple = MEASURED_AUDIO_MS / MEASURED_WHISPER_LARGE_V3_FP16_MS;

    // The two numbers are reciprocals; conflating them is the original defect.
    expect(realtimeFactor).toBeCloseTo(0.226, 3);
    expect(speedMultiple).toBeCloseTo(4.43, 2);
    expect(realtimeFactor).toBeLessThan(1);
    expect(speedMultiple).toBeGreaterThan(1);
    // The documented constant must be the factor, not the multiple.
    expect(MEASURED_WORST_REALTIME_FACTOR).toBeCloseTo(realtimeFactor, 2);
    expect(MEASURED_WORST_REALTIME_FACTOR).toBeLessThan(1);
  });

  it("rejects the 121-minute ceiling the inverted math produced", () => {
    const invertedCeiling = 60_000 + AUDIO_MAX_DURATION_MS * 12;
    expect(invertedCeiling).toBe(7_260_000);

    // The specific wrong answer, named so it cannot come back unnoticed.
    expect(transcribeTimeoutMs(AUDIO_MAX_DURATION_MS)).not.toBe(invertedCeiling);
    expect(TRANSCRIBE_TIMEOUT_CEILING_MS).not.toBe(invertedCeiling);
    // A ten-minute recording must not authorise a two-hour hang.
    expect(TRANSCRIBE_TIMEOUT_CEILING_MS).toBeLessThanOrEqual(20 * 60_000);
  });

  it("covers every supported macOS tier at maximum duration, with margin", () => {
    const budget = transcribeTimeoutMs(AUDIO_MAX_DURATION_MS);

    // Both measured models must fit, and by a wide enough margin to absorb
    // Apple silicon several times slower than the machine measured here.
    expect(budget).toBeGreaterThan(MEASURED_WHISPER_LARGE_V3_FP16_MS * 4);
    expect(budget).toBeGreaterThan(MEASURED_QWEN_06B_INT8_MS * 4);
    // ...but not so wide that a wedged worker outlives the user's patience.
    expect(budget).toBeLessThan(MEASURED_WHISPER_LARGE_V3_FP16_MS * 12);
  });

  it("keeps the tolerated realtime factor above the measured worst case", () => {
    expect(TRANSCRIBE_REALTIME_FACTOR_BUDGET).toBeGreaterThan(MEASURED_WORST_REALTIME_FACTOR);
    // Headroom for slower chips: an M1 is roughly 3-4x slower for MLX.
    expect(TRANSCRIBE_REALTIME_FACTOR_BUDGET / MEASURED_WORST_REALTIME_FACTOR)
      .toBeGreaterThanOrEqual(4);
  });

  it("scales with audio length rather than staying constant", () => {
    expect(transcribeTimeoutMs(60_000)).toBeLessThan(transcribeTimeoutMs(600_000));
    // The slope is the factor, so the difference is the extra audio, not a
    // multiple of it.
    const slope = (transcribeTimeoutMs(600_000) - transcribeTimeoutMs(60_000)) / 540_000;
    expect(slope).toBeCloseTo(TRANSCRIBE_REALTIME_FACTOR_BUDGET, 6);
  });

  it("still allows for a worker start and a cold model load on a very short clip", () => {
    // Slowest cold load measured on the packaged runtime was 16.6 s.
    expect(transcribeTimeoutMs(1)).toBeGreaterThanOrEqual(16_616 * 2);
    expect(transcribeTimeoutMs(1)).toBe(TRANSCRIBE_COLD_LOAD_BUDGET_MS + 1);
  });

  it("stays bounded so a wedged worker is still detected", () => {
    // A renderer-supplied duration is zod-clamped, but the budget must not
    // depend on that clamp to stay finite.
    expect(transcribeTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(TRANSCRIBE_TIMEOUT_CEILING_MS);
    expect(transcribeTimeoutMs(-1)).toBe(TRANSCRIBE_COLD_LOAD_BUDGET_MS);
    expect(Number.isFinite(TRANSCRIBE_TIMEOUT_CEILING_MS)).toBe(true);
  });
});

it("matches readiness only for the exact warm model, tier, and compute type", () => {
  expect(workerModelSelectionsMatch(medium, { ...medium })).toBe(true);
  expect(workerModelSelectionsMatch(null, medium)).toBe(false);
  expect(workerModelSelectionsMatch({ ...medium, modelId: "other/model" }, medium)).toBe(false);
  expect(workerModelSelectionsMatch({ ...medium, tier: "low" }, medium)).toBe(false);
  expect(workerModelSelectionsMatch({ ...medium, computeType: "float16" }, medium)).toBe(false);
});

class FakeWorkerProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdin = {
    write: (line: string, callback?: (error?: Error | null) => void) => {
      const request = JSON.parse(line) as Record<string, unknown>;
      requests.push(request);
      // Lets a test act at the exact moment a request reaches the worker, which
      // is the only way to model a Quit that lands mid-operation.
      onWorkerRequest?.(request);
      queueMicrotask(() => {
        switch (request.type) {
          case "install_model":
            this.respond({
              type: "model_installed",
              id: request.id,
              modelId: request.modelId,
              tier: request.tier,
              computeType: request.computeType,
              installMs: 1,
            });
            break;
          case "load_model":
            if (failingModelIds.has(String(request.modelId))) {
              this.respond({
                type: "error",
                id: request.id,
                code: "model_load_failed",
                message: "Metal device ran out of memory while loading the model",
              });
              break;
            }
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
          case "begin_live":
            this.respond({ type: "live_started", id: request.id });
            break;
          case "append_live":
            this.respond({ type: "partial", id: request.id, text: "partial" });
            break;
          case "finish_live":
            this.respond({
              type: "final",
              id: request.id,
              text: "live final",
              language: "en",
              inferenceMs: 4,
            });
            break;
          case "cancel_live":
            this.respond({ type: "live_cancelled", id: request.id });
            break;
          case "device_info":
            this.respond({
              type: "device_info",
              id: request.id,
              hardware: {
                platform: "darwin",
                architecture: "arm64",
                chip: "Apple Test",
                unifiedMemory: {
                  totalBytes: 32 * 1024 ** 3,
                  availableBytes: 20 * 1024 ** 3,
                  availableIsEstimated: true,
                  memoryBasis: "vm_stat_free_inactive_speculative",
                },
              },
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
    queueMicrotask(() => this.respond({
      type: "hello",
      protocol: 1,
      backend: "localscribe-mlx-asr",
      version: "mlx-whisper/0.4.3;mlx-audio/0.4.6",
    }));
  }

  kill(): boolean {
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

/** Model ids whose `load_model` the fake worker rejects. */
const failingModelIds = new Set<string>();

const medium: WorkerModelSelection = {
  modelId: "example/medium",
  tier: "medium",
  computeType: "int8",
};

const high: WorkerModelSelection = {
  modelId: "example/high",
  tier: "high",
  computeType: "float16",
};

function supervisor(): WorkerSupervisor {
  return new WorkerSupervisor("/worker", "/models", "/environment");
}

beforeEach(() => {
  requests.length = 0;
  failingModelIds.clear();
  onWorkerRequest = null;
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const process = new FakeWorkerProcess();
    process.start();
    return process as never;
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WorkerSupervisor model lifecycle", () => {
  it("uses the exact bounded Live worker protocol and rejects sequence gaps", async () => {
    const worker = supervisor();
    const sink = await worker.beginLive({
      session: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        protocolVersion: 1,
        sampleRateHz: 16_000,
        channels: 1,
      },
      model: { ...medium, asrMode: "live" },
      language: "en",
      context: "",
    });
    await sink.write({
      sequence: 0,
      sampleRateHz: 16_000,
      channels: 1,
      sampleCount: 320,
      pcm: new ArrayBuffer(640),
    }, new AbortController().signal);
    await expect(sink.write({
      sequence: 2,
      sampleRateHz: 16_000,
      channels: 1,
      sampleCount: 320,
      pcm: new ArrayBuffer(640),
    }, new AbortController().signal)).rejects.toThrow(/violated/u);

    expect(requests.find((request) => request.type === "load_model")).toMatchObject({
      asrMode: "live",
    });
    expect(requests.find((request) => request.type === "begin_live")).toMatchObject({
      language: "en",
      context: "",
    });
    await worker.shutdown();
  });

  it("aggregates Live PCM under the Python line-protocol limit and finalizes exactly once", async () => {
    const worker = supervisor();
    const sessionId = "00000000-0000-4000-8000-000000000002";
    const sink = await worker.beginLive({
      session: { sessionId, protocolVersion: 1, sampleRateHz: 16_000, channels: 1 },
      model: { ...medium, asrMode: "live" },
      language: "en",
      context: "",
    });
    for (let sequence = 0; sequence < 13; sequence += 1) {
      await sink.write({
        sequence,
        sampleRateHz: 16_000,
        channels: 1,
        sampleCount: 320,
        pcm: new ArrayBuffer(640),
      }, new AbortController().signal);
    }
    await expect(worker.finishLiveWithResult(sessionId)).resolves.toMatchObject({ text: "live final" });
    await expect(worker.finishLiveWithResult(sessionId)).rejects.toThrow(/cancelled/u);
    const appends = requests.filter((request) => request.type === "append_live");
    expect(appends).toHaveLength(2);
    for (const append of appends) {
      expect(Buffer.from(String(append.audioBase64), "base64").byteLength).toBeLessThanOrEqual(8 * 1024);
    }
    expect(requests.filter((request) => request.type === "finish_live")).toHaveLength(1);
    await worker.shutdown();
  });

  it("keeps handshake versions fail-closed against the exact worker dependency pins", () => {
    const macProject = readFileSync("worker/pyproject.toml", "utf8");
    const windowsProject = readFileSync(
      "worker/windows_transformers/pyproject.toml",
      "utf8",
    );
    const exactPin = (source: string, packageName: string) => {
      const match = source.match(new RegExp(
        `["']${packageName.replace("-", "\\-")}(?:\\[[^\\]]+\\])?==([^;"']+)`,
      ));
      if (!match?.[1]) throw new Error(`Missing exact ${packageName} worker pin`);
      return match[1];
    };

    expect(WORKER_RUNTIME_IDENTITIES.localscribe_worker.version).toBe(
      [
        `mlx-whisper/${exactPin(macProject, "mlx-whisper")}`,
        `mlx-audio/${exactPin(macProject, "mlx-audio")}`,
      ].join(";"),
    );
    expect(WORKER_RUNTIME_IDENTITIES.localscribe_windows_worker.version).toBe(
      `faster-whisper/${exactPin(windowsProject, "faster-whisper")};crispasr/0.8.24`,
    );
  });

  it("coalesces a same-model load and forwards no ambient credential environment", async () => {
    vi.stubEnv("HF_TOKEN", "must-not-cross-process-boundary");
    vi.stubEnv("HTTPS_PROXY", "http://sensitive-proxy.invalid");
    const worker = supervisor();

    await Promise.all([
      worker.ensureReady(medium),
      worker.ensureReady(medium),
    ]);

    expect(requests.filter((request) => request.type === "load_model")).toHaveLength(1);
    const spawnOptions = spawnMock.mock.calls[0]?.[2];
    expect(spawnOptions?.shell).toBe(false);
    expect(spawnOptions?.windowsHide).toBe(true);
    expect(spawnOptions?.env).toMatchObject({
      HF_HUB_DISABLE_TELEMETRY: "1",
      HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8:strict",
    });
    expect(spawnOptions?.env).not.toHaveProperty("HF_TOKEN");
    expect(spawnOptions?.env).not.toHaveProperty("HTTPS_PROXY");
  });

  it("reports the warm selection without mutating or reloading it", async () => {
    const worker = supervisor();
    expect(worker.loadedSelection()).toBeNull();

    await worker.ensureReady(medium);
    const snapshot = worker.loadedSelection();
    expect(snapshot).toEqual(medium);
    if (snapshot) snapshot.modelId = "mutated/outside";
    expect(worker.loadedSelection()).toEqual(medium);

    await worker.ensureReady(medium);
    expect(requests.filter((request) => request.type === "load_model")).toHaveLength(1);
    await worker.shutdown();
    expect(worker.loadedSelection()).toBeNull();
  });

  /*
   * Auto mode may pick a different tier at a recording boundary, and the
   * dictation path loads it through the same `ensureReady`. Switching tiers
   * stops the warm process first, so a failed load leaves no runtime at all —
   * and if the supervisor still believed the old selection was warm, the next
   * dictation would match it, skip the load entirely, and transcribe against a
   * process that no longer exists.
   */
  it("forgets the warm selection when a tier switch fails, so the next dictation reloads", async () => {
    const worker = supervisor();
    await worker.ensureReady(medium);
    expect(worker.loadedSelection()).toEqual(medium);

    failingModelIds.add(high.modelId);
    await expect(worker.ensureReady(high)).rejects.toThrow(/model_load_failed/u);

    // Nothing is warm: the previous runtime was stopped to make room.
    expect(worker.loadedSelection()).toBeNull();

    failingModelIds.clear();
    const loadsBefore = requests.filter((request) => request.type === "load_model").length;
    await worker.ensureReady(medium);
    expect(worker.loadedSelection()).toEqual(medium);
    expect(requests.filter((request) => request.type === "load_model").length)
      .toBe(loadsBefore + 1);
  });

  it("normalizes platform-specific accelerator telemetry", async () => {
    await expect(supervisor().deviceInfo()).resolves.toEqual({
      kind: "apple-unified",
      displayName: "Apple Test",
      totalMemoryBytes: 32 * 1024 ** 3,
      freeMemoryBytes: 20 * 1024 ** 3,
      memoryBasis: "estimated",
      sourceBasis: "vm_stat_free_inactive_speculative",
    });
  });

  it("normalizes Windows NVML telemetry from the exact CUDA worker", async () => {
    spawnMock.mockImplementation(() => {
      const process = new FakeWorkerProcess();
      const originalWrite = process.stdin.write;
      process.stdin.write = (line, callback) => {
        const request = JSON.parse(line) as Record<string, unknown>;
        if (request.type !== "device_info") return originalWrite(line, callback);
        requests.push(request);
        queueMicrotask(() => {
          process.stdout.emit("data", Buffer.from(`${JSON.stringify({
            type: "device_info",
            id: request.id,
            acceleratorKind: "nvidia-cuda",
            deviceName: "NVIDIA GeForce RTX 3060 Laptop GPU",
            deviceIndex: 0,
            totalVramBytes: 6 * 1024 ** 3,
            freeVramBytes: 6_285_164_544,
            memoryBasis: "nvml-current",
          })}\n`, "utf8"));
        });
        callback?.(null);
        return true;
      };
      queueMicrotask(() => {
        process.stdout.emit("data", Buffer.from(`${JSON.stringify({
          type: "hello",
          protocol: 1,
          backend: "localscribe-windows-asr",
          version: "faster-whisper/1.2.1;crispasr/0.8.24",
        })}\n`, "utf8"));
      });
      return process as never;
    });
    const worker = new WorkerSupervisor(
      "/worker/windows_transformers",
      "/models",
      "/environment",
      null,
      "localscribe_windows_worker",
    );

    await expect(worker.deviceInfo()).resolves.toEqual({
      kind: "nvidia-cuda",
      displayName: "NVIDIA GeForce RTX 3060 Laptop GPU",
      deviceIndex: 0,
      totalMemoryBytes: 6 * 1024 ** 3,
      freeMemoryBytes: 6_285_164_544,
      memoryBasis: "measured",
      sourceBasis: "nvml-current",
    });
  });

  it.each([
    ["NVIDIA RTX A2000 Laptop GPU", 4, 3],
    ["NVIDIA GeForce RTX 4090", 24, 17],
    ["NVIDIA L40S", 48, 41],
  ])(
    "accepts arbitrary NVML device names and capacities without a GPU-name allowlist: %s",
    async (deviceName, totalGiB, freeGiB) => {
      spawnMock.mockImplementation(() => {
        const process = new FakeWorkerProcess();
        const originalWrite = process.stdin.write;
        process.stdin.write = (line, callback) => {
          const request = JSON.parse(line) as Record<string, unknown>;
          if (request.type !== "device_info") return originalWrite(line, callback);
          requests.push(request);
          queueMicrotask(() => {
            process.stdout.emit("data", Buffer.from(`${JSON.stringify({
              type: "device_info",
              id: request.id,
              acceleratorKind: "nvidia-cuda",
              deviceName,
              deviceIndex: 2,
              totalVramBytes: totalGiB * 1024 ** 3,
              freeVramBytes: freeGiB * 1024 ** 3,
              memoryBasis: "nvml-current",
            })}\n`, "utf8"));
          });
          callback?.(null);
          return true;
        };
        queueMicrotask(() => {
          process.stdout.emit("data", Buffer.from(`${JSON.stringify({
            type: "hello",
            protocol: 1,
            backend: "localscribe-windows-asr",
            version: "faster-whisper/1.2.1;crispasr/0.8.24",
          })}\n`, "utf8"));
        });
        return process as never;
      });
      const worker = new WorkerSupervisor(
        "/worker/windows_transformers",
        "/models",
        "/environment",
        null,
        "localscribe_windows_worker",
      );

      await expect(worker.deviceInfo()).resolves.toMatchObject({
        kind: "nvidia-cuda",
        displayName: deviceName,
        deviceIndex: 2,
        totalMemoryBytes: totalGiB * 1024 ** 3,
        freeMemoryBytes: freeGiB * 1024 ** 3,
      });
    },
  );

  it.each([
    ["Apple M1", 8, 3],
    ["Apple M4 Max", 48, 31],
    [null, 128, 100],
  ])(
    "accepts arbitrary Apple unified-memory capacities without a chip-name allowlist: %s",
    async (chip, totalGiB, freeGiB) => {
      spawnMock.mockImplementation(() => {
        const process = new FakeWorkerProcess();
        const originalWrite = process.stdin.write;
        process.stdin.write = (line, callback) => {
          const request = JSON.parse(line) as Record<string, unknown>;
          if (request.type !== "device_info") return originalWrite(line, callback);
          requests.push(request);
          queueMicrotask(() => {
            process.stdout.emit("data", Buffer.from(`${JSON.stringify({
              type: "device_info",
              id: request.id,
              hardware: {
                platform: "darwin",
                architecture: "arm64",
                chip,
                unifiedMemory: {
                  totalBytes: totalGiB * 1024 ** 3,
                  availableBytes: freeGiB * 1024 ** 3,
                  availableIsEstimated: true,
                  memoryBasis: "vm_stat_free_inactive_speculative",
                },
              },
            })}\n`, "utf8"));
          });
          callback?.(null);
          return true;
        };
        process.start();
        return process as never;
      });

      await expect(supervisor().deviceInfo()).resolves.toMatchObject({
        kind: "apple-unified",
        // The supervisor reports the hardware fact without an engine suffix;
        // main appends " · MLX" exactly once, so a fallback carrying its own
        // suffix rendered "Apple Silicon GPU · MLX · MLX".
        displayName: chip ?? "Apple Silicon GPU",
        totalMemoryBytes: totalGiB * 1024 ** 3,
        freeMemoryBytes: freeGiB * 1024 ** 3,
      });
    },
  );

  it("rejects Windows telemetry from the macOS worker identity", async () => {
    spawnMock.mockImplementation(() => {
      const process = new FakeWorkerProcess();
      const originalWrite = process.stdin.write;
      process.stdin.write = (line, callback) => {
        const request = JSON.parse(line) as Record<string, unknown>;
        if (request.type !== "device_info") return originalWrite(line, callback);
        requests.push(request);
        queueMicrotask(() => {
          process.stdout.emit("data", Buffer.from(`${JSON.stringify({
            type: "device_info",
            id: request.id,
            acceleratorKind: "nvidia-cuda",
            deviceName: "NVIDIA spoof",
            deviceIndex: 0,
            totalVramBytes: 24 * 1024 ** 3,
            freeVramBytes: 20 * 1024 ** 3,
            memoryBasis: "nvml-current",
          })}\n`, "utf8"));
        });
        callback?.(null);
        return true;
      };
      process.start();
      return process as never;
    });

    await expect(supervisor().deviceInfo()).rejects.toThrow(
      "wrong runtime platform",
    );
  });

  it("rejects macOS telemetry from the Windows worker identity", async () => {
    spawnMock.mockImplementation(() => {
      const process = new FakeWorkerProcess();
      const originalWrite = process.stdin.write;
      process.stdin.write = (line, callback) => {
        const request = JSON.parse(line) as Record<string, unknown>;
        if (request.type !== "device_info") return originalWrite(line, callback);
        requests.push(request);
        queueMicrotask(() => {
          process.stdout.emit("data", Buffer.from(`${JSON.stringify({
            type: "device_info",
            id: request.id,
            hardware: {
              platform: "darwin",
              architecture: "arm64",
              chip: "Apple spoof",
              unifiedMemory: {
                totalBytes: 64 * 1024 ** 3,
                availableBytes: 50 * 1024 ** 3,
                availableIsEstimated: true,
                memoryBasis: "vm_stat_free_inactive_speculative",
              },
            },
          })}\n`, "utf8"));
        });
        callback?.(null);
        return true;
      };
      queueMicrotask(() => {
        process.stdout.emit("data", Buffer.from(`${JSON.stringify({
          type: "hello",
          protocol: 1,
          backend: "localscribe-windows-asr",
          version: "faster-whisper/1.2.1;crispasr/0.8.24",
        })}\n`, "utf8"));
      });
      return process as never;
    });
    const worker = new WorkerSupervisor(
      "/worker/windows_transformers",
      "/models",
      "/environment",
      null,
      "localscribe_windows_worker",
    );

    await expect(worker.deviceInfo()).rejects.toThrow(
      "wrong runtime platform",
    );
  });

  it("terminates a worker that reports internally inconsistent VRAM telemetry", async () => {
    spawnMock.mockImplementation(() => {
      const process = new FakeWorkerProcess();
      const originalWrite = process.stdin.write;
      process.stdin.write = (line, callback) => {
        const request = JSON.parse(line) as Record<string, unknown>;
        if (request.type !== "device_info") return originalWrite(line, callback);
        requests.push(request);
        queueMicrotask(() => {
          process.stdout.emit("data", Buffer.from(`${JSON.stringify({
            type: "device_info",
            id: request.id,
            acceleratorKind: "nvidia-cuda",
            deviceName: "Invalid GPU",
            deviceIndex: 0,
            totalVramBytes: 6 * 1024 ** 3,
            freeVramBytes: 7 * 1024 ** 3,
            memoryBasis: "nvml-current",
          })}\n`, "utf8"));
        });
        callback?.(null);
        return true;
      };
      queueMicrotask(() => {
        process.stdout.emit("data", Buffer.from(`${JSON.stringify({
          type: "hello",
          protocol: 1,
          backend: "localscribe-windows-asr",
          version: "faster-whisper/1.2.1;crispasr/0.8.24",
        })}\n`, "utf8"));
      });
      return process as never;
    });
    const worker = new WorkerSupervisor(
      "/worker/windows_transformers",
      "/models",
      "/environment",
      null,
      "localscribe_windows_worker",
    );

    await expect(worker.deviceInfo()).rejects.toThrow("violated the local protocol");
  });

  it("omits PATH as well as ambient credentials when bundled Python is absolute", async () => {
    vi.stubEnv("HF_TOKEN", "must-not-cross-process-boundary");
    const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "localscribe-runtime-"));
    temporaryDirectories.push(runtimeRoot);
    const executable = process.platform === "win32" ? "python.exe" : "python3";
    const executableDirectory = path.join(
      runtimeRoot,
      "venv",
      process.platform === "win32" ? "Scripts" : "bin",
    );
    mkdirSync(executableDirectory, { recursive: true });
    writeFileSync(path.join(executableDirectory, executable), "");
    const worker = new WorkerSupervisor("/worker", "/models", "/environment", runtimeRoot);

    await worker.ensureReady(medium);

    const spawnOptions = spawnMock.mock.calls[0]?.[2];
    expect(spawnOptions?.env).not.toHaveProperty("PATH");
    expect(spawnOptions?.env).not.toHaveProperty("HF_TOKEN");
  });

  it("uses only an explicitly supplied app-owned temporary directory", async () => {
    vi.stubEnv("TEMP", "C:\\ambient-temp");
    vi.stubEnv("TMP", "C:\\ambient-tmp");
    vi.stubEnv("TMPDIR", "/ambient-tmpdir");
    const workerTemp = path.join(os.tmpdir(), "localscribe-worker-temp");
    const worker = new WorkerSupervisor(
      "/worker",
      "/models",
      "/environment",
      null,
      "localscribe_worker",
      workerTemp,
    );

    await worker.ensureReady(medium);

    expect(spawnMock.mock.calls[0]?.[2]?.env).toMatchObject({
      TEMP: workerTemp,
      TMP: workerTemp,
      TMPDIR: workerTemp,
      HF_HOME: path.join(workerTemp, "huggingface"),
      HF_HUB_CACHE: path.join(workerTemp, "huggingface", "hub"),
      HF_XET_CACHE: path.join(workerTemp, "huggingface", "xet"),
    });
  });

  it("rejects a worker that identifies as the wrong packaged backend", async () => {
    spawnMock.mockImplementation(() => {
      const process = new FakeWorkerProcess();
      queueMicrotask(() => {
        process.stdout.emit("data", Buffer.from(`${JSON.stringify({
          type: "hello",
          protocol: 1,
          backend: "localscribe-windows-asr",
          version: "faster-whisper/1.2.1;crispasr/0.8.24",
        })}\n`, "utf8"));
      });
      return process as never;
    });

    await expect(supervisor().ensureReady(medium)).rejects.toThrow(
      "ASR worker identity mismatch",
    );
  });

  it("keeps transcription atomic before a queued model switch and restarts to unload", async () => {
    const worker = supervisor();
    const transcription = worker.transcribe({
      model: medium,
      audioPath: "/audio/request.wav",
      allowedRoot: "/audio",
      language: "auto",
      context: "",
      durationMs: 5_000,
    });
    const switched = worker.ensureReady(high);

    await expect(transcription).resolves.toMatchObject({ text: "local result" });
    await expect(switched).resolves.toBeUndefined();

    expect(requests.map((request) => request.type)).toEqual([
      "load_model",
      "transcribe",
      "shutdown",
      "load_model",
    ]);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(requests.filter((request) => request.type === "load_model")).toEqual([
      expect.objectContaining({
        modelId: medium.modelId,
        tier: medium.tier,
        computeType: medium.computeType,
        allowDownload: false,
      }),
      expect.objectContaining({
        modelId: high.modelId,
        tier: high.tier,
        computeType: high.computeType,
        allowDownload: false,
      }),
    ]);
  });

  it("accepts a maximum-sized valid transcription response", async () => {
    const expectedText = "a".repeat(100_000);
    spawnMock.mockImplementation(() => {
      const process = new FakeWorkerProcess();
      const originalWrite = process.stdin.write;
      process.stdin.write = (line, callback) => {
        const request = JSON.parse(line) as Record<string, unknown>;
        if (request.type !== "transcribe") return originalWrite(line, callback);
        requests.push(request);
        queueMicrotask(() => {
          process.stdout.emit("data", Buffer.from(`${JSON.stringify({
            type: "final",
            id: request.id,
            text: expectedText,
            language: "en",
            inferenceMs: 1,
          })}\n`, "utf8"));
        });
        callback?.(null);
        return true;
      };
      process.start();
      return process as never;
    });

    await expect(supervisor().transcribe({
      model: medium,
      audioPath: "/audio/request.wav",
      allowedRoot: "/audio",
      language: "en",
      context: "",
      durationMs: 5_000,
    })).resolves.toMatchObject({ text: expectedText });
  });

  it("aborts an in-flight transcription immediately instead of waiting for the queue", async () => {
    spawnMock.mockImplementation(() => {
      const process = new FakeWorkerProcess();
      const originalWrite = process.stdin.write;
      process.stdin.write = (line, callback) => {
        const request = JSON.parse(line) as Record<string, unknown>;
        if (request.type !== "transcribe") return originalWrite(line, callback);
        requests.push(request);
        callback?.(null);
        return true;
      };
      process.start();
      return process as never;
    });
    const worker = supervisor();
    const transcription = worker.transcribe({
      model: medium,
      audioPath: "/audio/request.wav",
      allowedRoot: "/audio",
      language: "auto",
      context: "",
      durationMs: 5_000,
    });
    await vi.waitFor(() =>
      expect(requests.some((request) => request.type === "transcribe")).toBe(true),
    );

    worker.abort("cancelled by test");

    await expect(transcription).rejects.toThrow("cancelled by test");
  });

  it("terminates a worker after a request timeout before allowing reuse", async () => {
    const worker = supervisor();
    await worker.ensureReady(medium);

    const request = (
      worker as unknown as {
        request(payload: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
      }
    ).request.bind(worker);
    await expect(request({ type: "unanswered_test_request" }, 5))
      .rejects.toThrow("ASR worker request timed out: unanswered_test_request");

    // The timed-out process may still have been working. A later operation
    // must start from a fresh process rather than trusting its old model state.
    await worker.ensureReady(medium);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(requests.filter((request) => request.type === "load_model")).toHaveLength(2);
  });

  it("terminates a worker after stdin failure before allowing reuse", async () => {
    let workerNumber = 0;
    spawnMock.mockImplementation(() => {
      workerNumber += 1;
      const process = new FakeWorkerProcess();
      if (workerNumber === 1) {
        process.stdin.write = (_line, callback) => {
          queueMicrotask(() => callback?.(new Error("broken worker stdin")));
          return false;
        };
      }
      process.start();
      return process as never;
    });
    const worker = supervisor();

    await expect(worker.ensureReady(medium)).rejects.toThrow("broken worker stdin");
    await worker.ensureReady(medium);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(requests.filter((request) => request.type === "load_model")).toHaveLength(1);
  });

  it("terminates a worker after mismatched model acknowledgement before reuse", async () => {
    let workerNumber = 0;
    spawnMock.mockImplementation(() => {
      workerNumber += 1;
      const process = new FakeWorkerProcess();
      if (workerNumber === 1) {
        const originalWrite = process.stdin.write;
        process.stdin.write = (line, callback) => {
          const request = JSON.parse(line) as Record<string, unknown>;
          if (request.type !== "load_model") return originalWrite(line, callback);
          requests.push(request);
          queueMicrotask(() => {
            process.stdout.emit("data", Buffer.from(`${JSON.stringify({
              type: "model_ready",
              id: request.id,
              modelId: "unexpected/model",
              tier: request.tier,
              computeType: request.computeType,
              loadMs: 1,
            })}\n`, "utf8"));
          });
          callback?.(null);
          return true;
        };
      }
      process.start();
      return process as never;
    });
    const worker = supervisor();

    await expect(worker.ensureReady(medium)).rejects.toThrow(
      "acknowledged a model selection other than",
    );
    await worker.ensureReady(medium);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(requests.filter((request) => request.type === "load_model")).toHaveLength(2);
  });

  it("terminates a worker that emits a response for an unknown request", async () => {
    let workerNumber = 0;
    spawnMock.mockImplementation(() => {
      workerNumber += 1;
      const process = new FakeWorkerProcess();
      if (workerNumber === 1) {
        const originalWrite = process.stdin.write;
        process.stdin.write = (line, callback) => {
          const request = JSON.parse(line) as Record<string, unknown>;
          if (request.type !== "load_model") return originalWrite(line, callback);
          requests.push(request);
          queueMicrotask(() => {
            process.stdout.emit("data", Buffer.from(`${JSON.stringify({
              type: "health",
              id: "00000000-0000-4000-8000-000000000000",
              ready: false,
            })}\n`, "utf8"));
          });
          callback?.(null);
          return true;
        };
      }
      process.start();
      return process as never;
    });
    const worker = supervisor();

    await expect(worker.ensureReady(medium)).rejects.toThrow(
      "response for an unknown request",
    );
    await worker.ensureReady(medium);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(requests.filter((request) => request.type === "load_model")).toHaveLength(2);
  });

  it("tracks a stubborn terminated worker and refuses an overlapping process", async () => {
    vi.useFakeTimers();
    try {
      const worker = supervisor();
      await worker.ensureReady(medium);
      const child = spawnMock.mock.results[0]?.value as FakeWorkerProcess;
      child.kill = () => false;
      (
        worker as unknown as {
          terminateWorker(
            process: FakeWorkerProcess,
            error: Error,
          ): void;
        }
      ).terminateWorker(child, new Error("simulated protocol failure"));

      const replacement = worker.ensureReady(medium);
      await vi.advanceTimersByTimeAsync(2_001);
      await expect(replacement).rejects.toThrow(
        "refusing to start an overlapping model process",
      );
      expect(spawnMock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("installs through the data-only protocol without loading a runtime", async () => {
    const worker = supervisor();

    await worker.installModel(medium);

    expect(requests.map((request) => request.type)).toEqual(["install_model", "shutdown"]);
    expect(requests).toContainEqual(expect.objectContaining({
      type: "install_model",
      modelId: medium.modelId,
      tier: medium.tier,
      computeType: medium.computeType,
      modelRoot: "/models",
      allowDownload: true,
    }));
    expect(requests.some((request) => request.type === "load_model")).toBe(false);
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it("preserves an unrelated warm runtime during a serialized installation", async () => {
    const worker = supervisor();

    await worker.ensureReady(medium);
    await worker.installModel(high);

    expect(requests.map((request) => request.type)).toEqual([
      "load_model",
      "install_model",
    ]);
    expect(requests.some((request) => (
      request.type === "load_model" && request.modelId === high.modelId
    ))).toBe(false);
    expect(worker.loadedSelection()).toEqual(medium);
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it("unloads a replaced warm artifact and restores its exact prior selection", async () => {
    const worker = supervisor();

    await worker.ensureReady(medium);
    await worker.installModel(high, { replacesLoadedArtifact: true });

    expect(requests.map((request) => request.type)).toEqual([
      "load_model",
      "shutdown",
      "install_model",
      "shutdown",
      "load_model",
    ]);
    expect(requests.filter((request) => request.type === "load_model")).toEqual([
      expect.objectContaining(medium),
      expect.objectContaining(medium),
    ]);
    expect(worker.loadedSelection()).toEqual(medium);
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });

  /*
   * `shutdown()` is serialized behind whatever model operation is running, so a
   * repair of the warm artifact used to reload a multi-gigabyte model inside its
   * own rollback while Quit was already refusing IPC — the app stayed on screen,
   * dead, until that load finished or hit the 20-minute timeout.
   */
  it("does not rebuild the rolled-back runtime once the application is quitting", async () => {
    const worker = supervisor();

    await worker.ensureReady(medium);
    // Quit lands while the install is already in flight, which is the real
    // window: the user starts a repair, then chooses Quit.
    onWorkerRequest = (request) => {
      if (request.type === "install_model") worker.retire();
    };
    await worker.installModel(high, { replacesLoadedArtifact: true });

    expect(requests.map((request) => request.type)).toEqual([
      "load_model",
      "shutdown",
      "install_model",
      "shutdown",
    ]);
    expect(requests.filter((request) => request.type === "load_model")).toEqual([
      expect.objectContaining(medium),
    ]);
    expect(worker.loadedSelection()).toBeNull();
  });

  it("refuses to start another worker process after retirement", async () => {
    const worker = supervisor();

    await worker.ensureReady(medium);
    const spawnsBeforeRetirement = spawnMock.mock.calls.length;
    worker.retire();
    await worker.shutdown();

    await expect(worker.ensureReady(medium)).rejects.toThrow("LocalScribe is shutting down");
    await expect(worker.installModel(high)).rejects.toThrow("LocalScribe is shutting down");
    expect(spawnMock).toHaveBeenCalledTimes(spawnsBeforeRetirement);
  });

  it("keeps load_model download-disabled after an explicit install", async () => {
    const worker = supervisor();

    await worker.installModel(medium);
    await worker.ensureReady(medium);

    expect(requests.filter((request) => request.type === "load_model")).toEqual([
      expect.objectContaining({
        modelId: medium.modelId,
        tier: medium.tier,
        computeType: medium.computeType,
        allowDownload: false,
      }),
    ]);
  });
});

describe("model install request budget", () => {
  /*
   * The budget used to be a flat 20 minutes for every artifact, which is a
   * throughput requirement in disguise: the flagship tiers could not finish
   * inside it below roughly 21 Mbit/s, and each timeout terminated the worker
   * mid-download.
   */
  const WHISPER_LARGE_V3_BYTES = 3_083_520_685;
  const QWEN_1_7B_BF16_BYTES = 4_080_710_353;

  it("gives every catalog artifact more than the old flat 20-minute budget", () => {
    for (const bytes of [WHISPER_LARGE_V3_BYTES, QWEN_1_7B_BF16_BYTES]) {
      expect(installTimeoutMs(bytes)).toBeGreaterThan(20 * 60_000);
    }
  });

  it("requires no more than 1 MiB/s sustained for the largest artifact", () => {
    const budget = installTimeoutMs(QWEN_1_7B_BF16_BYTES);
    const transferWindowSeconds = (budget - 5 * 60_000) / 1000;
    expect(QWEN_1_7B_BF16_BYTES / transferWindowSeconds)
      .toBeLessThanOrEqual(INSTALL_MIN_BYTES_PER_SECOND);
  });

  it("scales with the artifact instead of holding one cap for every tier", () => {
    expect(installTimeoutMs(QWEN_1_7B_BF16_BYTES))
      .toBeGreaterThan(installTimeoutMs(WHISPER_LARGE_V3_BYTES));
    expect(installTimeoutMs(1_000_000_000)).toBeLessThan(installTimeoutMs(3_000_000_000));
  });

  it("still allows a fixed startup allowance for a zero-byte manifest", () => {
    expect(installTimeoutMs(0)).toBe(5 * 60_000);
    expect(installTimeoutMs(-1)).toBe(5 * 60_000);
  });

  it("clamps a malformed manifest instead of minting an unbounded timer", () => {
    expect(installTimeoutMs(Number.MAX_SAFE_INTEGER))
      .toBe(installTimeoutMs(INSTALL_MAX_ARTIFACT_BYTES));
  });

  it("is what the supervisor actually arms for install_model", () => {
    const source = readFileSync("src/main/worker/workerSupervisor.ts", "utf8");
    const install = source.slice(source.indexOf('type: "install_model"'));
    const request = install.slice(0, install.indexOf("modelInstalledMessageSchema"));

    expect(request).toContain("installTimeoutMs(options.artifactBytes ?? INSTALL_MAX_ARTIFACT_BYTES)");
    // No flat literal may survive in the install request itself. The separate
    // load_model budget is a local read with no network and keeps its own.
    expect(request).not.toMatch(/\d+ \* 60_000/u);
  });
});
