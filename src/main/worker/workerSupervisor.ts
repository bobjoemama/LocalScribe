import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { modelPerformanceTierSchema, type ModelPerformanceTier } from "../../shared/modelPerformance";

const computeTypeSchema = z.enum([
  "float16",
  "int8_float16",
  "int8",
  "int4",
]);
export type WorkerComputeType = z.infer<typeof computeTypeSchema>;

const helloMessageSchema = z.object({
  type: z.literal("hello"),
  protocol: z.literal(1),
  backend: z.string().min(1).max(120),
  version: z.string().min(1).max(120),
}).strict();

const modelReadyMessageSchema = z.object({
  type: z.literal("model_ready"),
  id: z.string().uuid(),
  tier: modelPerformanceTierSchema,
  modelId: z.string().min(1).max(200),
  computeType: computeTypeSchema,
  loadMs: z.number().nonnegative(),
}).strict();

const modelInstalledMessageSchema = z.object({
  type: z.literal("model_installed"),
  id: z.string().uuid(),
  tier: modelPerformanceTierSchema,
  modelId: z.string().min(1).max(200),
  computeType: computeTypeSchema,
  installMs: z.number().nonnegative(),
}).strict();

const macDeviceInfoMessageSchema = z.object({
  type: z.literal("device_info"),
  id: z.string().uuid(),
  hardware: z.object({
    platform: z.literal("darwin"),
    architecture: z.literal("arm64"),
    chip: z.string().min(1).max(200).nullable(),
    unifiedMemory: z.object({
      totalBytes: z.number().int().positive(),
      availableBytes: z.number().int().nonnegative(),
      availableIsEstimated: z.literal(true),
      memoryBasis: z.literal("vm_stat_free_inactive_speculative"),
    }).strict(),
  }).strict(),
}).strict();

const windowsDeviceInfoMessageSchema = z.object({
  type: z.literal("device_info"),
  id: z.string().uuid(),
  acceleratorKind: z.literal("nvidia-cuda"),
  deviceName: z.string().min(1).max(200),
  totalVramBytes: z.number().int().positive(),
  freeVramBytes: z.number().int().nonnegative(),
  memoryBasis: z.literal("nvml-current"),
}).strict();

const workerMessageSchema = z.union([
  helloMessageSchema,
  modelReadyMessageSchema,
  modelInstalledMessageSchema,
  z.object({
    type: z.literal("health"),
    id: z.string().uuid(),
    ready: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("final"),
    id: z.string().uuid(),
    text: z.string(),
    language: z.string().nullable().optional(),
    inferenceMs: z.number().nonnegative(),
  }).strict(),
  z.object({
    type: z.literal("shutdown"),
    id: z.string().uuid(),
  }).strict(),
  z.object({
    type: z.literal("error"),
    id: z.string().uuid().nullable(),
    code: z.string().min(1).max(120),
    message: z.string().max(2_000),
  }).strict(),
  macDeviceInfoMessageSchema,
  windowsDeviceInfoMessageSchema,
]);

type WorkerMessage = z.infer<typeof workerMessageSchema>;

interface PendingRequest {
  resolve(message: WorkerMessage): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export interface WorkerModelSelection {
  modelId: string;
  tier: ModelPerformanceTier;
  computeType: WorkerComputeType;
}

export interface WorkerTranscription {
  text: string;
  language: string | null;
  inferenceMs: number;
}

export interface WorkerAcceleratorSnapshot {
  kind: "apple-unified" | "nvidia-cuda";
  displayName: string;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  memoryBasis: "measured" | "estimated";
  sourceBasis: "vm_stat_free_inactive_speculative" | "nvml-current";
}

const MAX_WORKER_STDOUT_LINE_BYTES = 64 * 1024;

export class WorkerSupervisor {
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private hello: Promise<void> | null = null;
  private resolveHello: (() => void) | null = null;
  private rejectHello: ((error: Error) => void) | null = null;
  private stdoutBuffer = Buffer.alloc(0);
  private activeModel: WorkerModelSelection | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly workerDirectory: string,
    private readonly modelRoot: string,
    private readonly environmentDirectory: string,
    private readonly bundledRuntimeDirectory: string | null = null,
    private readonly workerModule = "localscribe_worker",
  ) {}

  ensureReady(selection: WorkerModelSelection): Promise<void> {
    return this.serialize(() => this.ensureReadyUnlocked(selection));
  }

  /**
   * Installs and verifies model data without constructing an inference
   * runtime. A new worker process provides the unload boundary before an
   * installation or repair, and is stopped again afterward so the next
   * dictation must explicitly load its selected model.
   */
  installModel(selection: WorkerModelSelection): Promise<void> {
    return this.serialize(async () => {
      await this.stopProcessUnlocked();
      try {
        await this.ensureStarted();
        const response = await this.request(
          {
            type: "install_model",
            modelId: selection.modelId,
            tier: selection.tier,
            computeType: selection.computeType,
            modelRoot: this.modelRoot,
            allowDownload: true,
          },
          20 * 60_000,
        );
        const installed = modelInstalledMessageSchema.safeParse(response);
        if (!installed.success) {
          throw new Error(`Unexpected worker response: ${response.type}`);
        }
        if (
          installed.data.modelId !== selection.modelId
          || installed.data.tier !== selection.tier
          || installed.data.computeType !== selection.computeType
        ) {
          throw new Error("ASR worker acknowledged installation for a model selection other than the validated catalog tier");
        }
      } finally {
        // `install_model` is intentionally data-only. Stopping here also
        // makes repair safe when the preceding process had a runtime loaded.
        await this.stopProcessUnlocked();
      }
    });
  }

  transcribe(input: {
    model: WorkerModelSelection;
    audioPath: string;
    allowedRoot: string;
    language: string;
    context: string;
  }): Promise<WorkerTranscription> {
    return this.serialize(async () => {
      // Dictation is deliberately incapable of downloading. Installation is
      // an explicit, separately validated main-process operation.
      await this.ensureReadyUnlocked(input.model);
      const response = await this.request(
        {
          type: "transcribe",
          audioPath: input.audioPath,
          allowedRoot: input.allowedRoot,
          language: input.language,
          context: input.context,
        },
        120_000,
      );
      if (response.type !== "final") {
        throw new Error(`Unexpected worker response: ${response.type}`);
      }
      return {
        text: response.text,
        language: response.language ?? null,
        inferenceMs: response.inferenceMs,
      };
    });
  }

  deviceInfo(): Promise<WorkerAcceleratorSnapshot> {
    return this.serialize(async () => {
      await this.ensureStarted();
      const response = await this.request({ type: "device_info" }, 30_000);
      const mac = macDeviceInfoMessageSchema.safeParse(response);
      if (mac.success) {
        const memory = mac.data.hardware.unifiedMemory;
        return {
          kind: "apple-unified",
          displayName: mac.data.hardware.chip ?? "Apple Silicon GPU · MLX",
          totalMemoryBytes: memory.totalBytes,
          freeMemoryBytes: memory.availableBytes,
          memoryBasis: "estimated",
          sourceBasis: memory.memoryBasis,
        };
      }
      const windows = windowsDeviceInfoMessageSchema.safeParse(response);
      if (windows.success) {
        return {
          kind: "nvidia-cuda",
          displayName: windows.data.deviceName,
          totalMemoryBytes: windows.data.totalVramBytes,
          freeMemoryBytes: windows.data.freeVramBytes,
          memoryBasis: "measured",
          sourceBasis: windows.data.memoryBasis,
        };
      }
      throw new Error(`Unexpected worker response: ${response.type}`);
    });
  }

  shutdown(): Promise<void> {
    return this.serialize(() => this.stopProcessUnlocked());
  }

  /**
   * Cancels an in-flight request without waiting behind the serialized model
   * queue. This is reserved for user cancellation and process shutdown.
   */
  abort(message = "ASR worker operation was cancelled"): void {
    const child = this.process;
    if (!child) return;
    this.terminateWorker(child, new Error(message));
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail
      .catch(() => undefined)
      .then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async ensureReadyUnlocked(selection: WorkerModelSelection): Promise<void> {
    if (sameSelection(this.activeModel, selection)) return;
    if (this.activeModel) {
      // A fresh process is the narrowest cross-backend unload guarantee. It
      // prevents two large runtimes from overlapping during a tier switch.
      await this.stopProcessUnlocked();
    }
    await this.ensureStarted();
    let response: WorkerMessage;
    try {
      response = await this.request(
        {
          type: "load_model",
          modelId: selection.modelId,
          tier: selection.tier,
          computeType: selection.computeType,
          modelRoot: this.modelRoot,
          // Normal inference must never fetch weights. Model data is only
          // acquired through the explicit `install_model` operation above.
          allowDownload: false,
        },
        20 * 60_000,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("model_not_installed")) {
        throw new Error(
          "Local speech model is not installed. Open LocalScribe Settings > Model & Performance to install it before dictating.",
        );
      }
      throw error;
    }
    const ready = modelReadyMessageSchema.safeParse(response);
    if (!ready.success) {
      throw new Error(`Unexpected worker response: ${response.type}`);
    }
    if (
      ready.data.modelId !== selection.modelId
      || ready.data.tier !== selection.tier
      || ready.data.computeType !== selection.computeType
    ) {
      throw new Error("ASR worker acknowledged a model selection other than the validated catalog tier");
    }
    this.activeModel = { ...selection };
  }

  private async ensureStarted(): Promise<void> {
    if (this.process && this.hello) return this.hello;
    this.hello = new Promise<void>((resolve, reject) => {
      this.resolveHello = resolve;
      this.rejectHello = reject;
    });
    const bundledPython = this.findBundledPython();
    if (this.bundledRuntimeDirectory && !bundledPython) {
      this.resetProcessState();
      throw new Error("Bundled Python runtime is missing from this LocalScribe build");
    }
    const command = bundledPython ?? "uv";
    const args = bundledPython
      ? ["-B", "-m", this.workerModule]
      : ["run", "--project", this.workerDirectory, "python", "-B", "-m", this.workerModule];
    const child = spawn(
      command,
      args,
      {
        cwd: this.workerDirectory,
        env: this.workerEnvironment(Boolean(bundledPython)),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.process = child;
    this.stdoutBuffer = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => this.handleStdoutChunk(child, chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      console.error(`[asr-worker] ${chunk.toString("utf8").trimEnd()}`);
    });
    child.on("error", (error) => this.handleExit(child, error));
    child.on("exit", (code, signal) =>
      this.handleExit(child, new Error(`ASR worker exited (${code ?? signal ?? "unknown"})`)),
    );

    const startupTimeout = setTimeout(() => {
      this.terminateWorker(child, new Error("ASR worker did not start in time"));
    }, 30_000);
    startupTimeout.unref();
    try {
      await this.hello;
    } finally {
      clearTimeout(startupTimeout);
    }
  }

  private workerEnvironment(usingBundledPython: boolean): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      PYTHONUNBUFFERED: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      HF_HUB_DISABLE_TELEMETRY: "1",
      HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
      UV_PROJECT_ENVIRONMENT: this.environmentDirectory,
      PYTHONPATH: this.workerDirectory,
    };
    if (!usingBundledPython && process.env.PATH) {
      // Development needs PATH solely to locate `uv`; packaged builds launch
      // an absolute bundled Python and inherit no executable search path.
      environment.PATH = process.env.PATH;
    }
    if (process.platform === "win32") {
      // These are OS runtime locations, not credentials. CPython and native
      // Windows DLL loading require them even when python.exe is absolute.
      if (process.env.SystemRoot) environment.SystemRoot = process.env.SystemRoot;
      if (process.env.WINDIR) environment.WINDIR = process.env.WINDIR;
    }
    return environment;
  }

  private findBundledPython(): string | null {
    const root = this.bundledRuntimeDirectory;
    if (!root || !existsSync(root)) return null;
    const executable = process.platform === "win32" ? "python.exe" : "python3";
    const bundledVenv = path.join(root, "venv", process.platform === "win32" ? "Scripts" : "bin", executable);
    if (existsSync(bundledVenv)) return bundledVenv;
    const direct = path.join(root, process.platform === "win32" ? "" : "bin", executable);
    if (existsSync(direct)) return direct;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name, process.platform === "win32" ? "" : "bin", executable);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  private request(payload: Record<string, unknown>, timeoutMs: number): Promise<WorkerMessage> {
    const child = this.process;
    if (!child) return Promise.reject(new Error("ASR worker is not running"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ASR worker request timed out: ${String(payload.type)}`));
      }, timeoutMs);
      timeout.unref();
      this.pending.set(id, { resolve, reject, timeout });
      child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private handleStdoutChunk(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (this.process !== child) return;
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    if (this.stdoutBuffer.byteLength > MAX_WORKER_STDOUT_LINE_BYTES && !this.stdoutBuffer.includes(0x0a)) {
      this.terminateWorker(child, new Error("ASR worker stdout line exceeded the protocol limit"));
      return;
    }
    let newline = this.stdoutBuffer.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.byteLength > MAX_WORKER_STDOUT_LINE_BYTES) {
        this.terminateWorker(child, new Error("ASR worker stdout line exceeded the protocol limit"));
        return;
      }
      if (line.byteLength > 0) this.handleLine(child, line.toString("utf8"));
      if (this.process !== child) return;
      newline = this.stdoutBuffer.indexOf(0x0a);
    }
    if (this.stdoutBuffer.byteLength > MAX_WORKER_STDOUT_LINE_BYTES) {
      this.terminateWorker(child, new Error("ASR worker stdout line exceeded the protocol limit"));
    }
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.terminateWorker(child, new Error("ASR worker emitted invalid JSON"));
      return;
    }
    const parsed = workerMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.terminateWorker(child, new Error("ASR worker violated the local protocol"));
      return;
    }
    const message = parsed.data;
    if (message.type === "hello") {
      if (!this.resolveHello) {
        this.terminateWorker(child, new Error("ASR worker emitted an unexpected duplicate handshake"));
        return;
      }
      this.resolveHello();
      this.resolveHello = null;
      this.rejectHello = null;
      return;
    }
    if (this.resolveHello) {
      this.terminateWorker(child, new Error("ASR worker responded before completing its handshake"));
      return;
    }
    if (message.type === "error" && message.id === null) {
      this.terminateWorker(child, new Error(`${message.code}: ${message.message}`));
      return;
    }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.type === "error") {
      pending.reject(new Error(`${message.code}: ${message.message}`));
    } else {
      pending.resolve(message);
    }
  }

  private async stopProcessUnlocked(): Promise<void> {
    const child = this.process;
    if (!child) return;
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    try {
      await this.request({ type: "shutdown" }, 2_000);
    } catch {
      // The process is force-killed below if it does not acknowledge shutdown.
    }
    await Promise.race([exited, delay(250)]);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.race([exited, delay(2_000)]);
    if (this.process === child) this.resetProcessState();
  }

  private terminateWorker(child: ChildProcessWithoutNullStreams, error: Error): void {
    this.handleExit(child, error);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.process !== child) return;
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
    this.rejectHello?.(error);
    this.resetProcessState();
  }

  private resetProcessState(): void {
    this.process = null;
    this.hello = null;
    this.resolveHello = null;
    this.rejectHello = null;
    this.stdoutBuffer = Buffer.alloc(0);
    this.activeModel = null;
  }
}

function sameSelection(
  left: WorkerModelSelection | null,
  right: WorkerModelSelection,
): boolean {
  return left?.modelId === right.modelId
    && left.tier === right.tier
    && left.computeType === right.computeType;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    timeout.unref();
  });
}
