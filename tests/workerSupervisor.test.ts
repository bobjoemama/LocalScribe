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
  WORKER_RUNTIME_IDENTITIES,
  WorkerSupervisor,
  workerModelSelectionsMatch,
  type WorkerModelSelection,
} from "../src/main/worker/workerSupervisor";

const spawnMock = vi.mocked(spawn);
const requests: Array<Record<string, unknown>> = [];
const temporaryDirectories: string[] = [];

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
        displayName: chip ?? "Apple Silicon GPU · MLX",
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
