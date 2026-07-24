import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import {
  WorkerSupervisor,
  type WorkerModelSelection,
} from "../src/main/worker/workerSupervisor";

const spawnMock = vi.mocked(spawn);
const requests: Array<Record<string, unknown>> = [];
const temporaryDirectories: string[] = [];

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
      backend: "test",
      version: "1",
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
    expect(spawnOptions?.env).toMatchObject({
      HF_HUB_DISABLE_TELEMETRY: "1",
      HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
    });
    expect(spawnOptions?.env).not.toHaveProperty("HF_TOKEN");
    expect(spawnOptions?.env).not.toHaveProperty("HTTPS_PROXY");
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

  it("unloads an active runtime before a serialized installation", async () => {
    const worker = supervisor();

    await worker.ensureReady(medium);
    await worker.installModel(high);

    expect(requests.map((request) => request.type)).toEqual([
      "load_model",
      "shutdown",
      "install_model",
      "shutdown",
    ]);
    expect(requests.some((request) => (
      request.type === "load_model" && request.modelId === high.modelId
    ))).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(2);
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
