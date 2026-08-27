import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AUDIO_MAX_DURATION_MS } from "../../shared/audioProtocol";
import {
  LIVE_AUDIO_FRAME_SAMPLES,
  type LiveAudioSessionDescriptor,
  type LiveAudioSink,
  type LivePcmFrame,
} from "../../shared/liveAudioTransport";
import { asrModeSchema, type AsrMode } from "../../shared/contracts";
import { modelPerformanceTierSchema, type ModelPerformanceTier } from "../../shared/modelPerformance";

/*
 * Two different numbers get called "realtime", and confusing them produced a
 * watchdog two orders of magnitude too slow. Both are named here so the
 * confusion cannot recur silently:
 *
 *   REALTIME FACTOR = inference wall clock / audio duration   (lower is faster)
 *   SPEED MULTIPLE  = audio duration / inference wall clock   (higher is faster)
 *
 * The previous constant read a measurement of 142 s for 600 s of audio as
 * "4.24x realtime" and multiplied by it. 142/600 is 0.237 — the 4.24 was the
 * SPEED MULTIPLE, i.e. the model is 4.24x FASTER than realtime. Multiplying by
 * it inverted the safety margin: the budget became 60 s + 600 s x 12 = 7,260 s,
 * a 121-minute timeout on a ten-minute recording. A wedged worker could hold
 * the session for two hours.
 */

/**
 * Fixed allowance for a worker start plus a cold model load.
 *
 * Measured cold loads on the packaged runtime, M4 Max: whisper-large-v3 fp16
 * 3.7 s - 16.6 s (page-cache dependent), qwen3-asr-0.6b 8-bit 5.5 s - 6.0 s.
 * 90 s is roughly 5x the slowest observed load and is spent only once per
 * process, so it costs nothing on the warm path this app is built around.
 */
export const TRANSCRIBE_COLD_LOAD_BUDGET_MS = 90_000;

/**
 * Worst REALTIME FACTOR measured across the supported macOS tiers, recorded so
 * the budget below can be checked against evidence rather than intuition.
 *
 * Packaged runtime, Apple M4 Max, 600 s of continuous speech (the longest
 * recording the protocol accepts):
 *
 *   whisper-large-v3 fp16   135.6 s   factor 0.226   (4.4x faster than realtime)
 *   qwen3-asr-0.6b 8-bit     10.5 s   factor 0.018   (57x faster than realtime)
 *
 * Whisper large-v3 fp16 is the heaviest artifact the macOS catalog ships, so
 * 0.226 is the number to size against.
 */
export const MEASURED_WORST_REALTIME_FACTOR = 0.226;

/**
 * REALTIME FACTOR the watchdog tolerates before declaring the worker wedged.
 *
 * 1.0 means "inference may take as long as the recording itself". That is 4.4x
 * the worst factor measured here, which covers Apple silicon several times
 * slower than an M4 Max — an M1 is roughly 3-4x slower for MLX inference, which
 * lands near 0.9 and still fits. It is chosen to be generous to slow hardware
 * and stingy with wedged workers, which is the only trade-off this constant
 * controls.
 */
export const TRANSCRIBE_REALTIME_FACTOR_BUDGET = 1;

/**
 * The budget is bounded because the duration is clamped to the longest
 * recording the app will accept, not by a separate wall-clock cap — an
 * independent cap would silently re-introduce the defect at the top of the
 * range. This is a last-resort backstop: a user who sees dictation hang
 * cancels, which aborts the in-flight request immediately.
 *
 * At the shipped constants this is 90 s + 600 s = 690 s (11.5 minutes) for a
 * maximum-length dictation, against 121 minutes before.
 */
export const TRANSCRIBE_TIMEOUT_CEILING_MS =
  TRANSCRIBE_COLD_LOAD_BUDGET_MS
  + AUDIO_MAX_DURATION_MS * TRANSCRIBE_REALTIME_FACTOR_BUDGET;

/** Fixed allowance for the worker start, hashing, and the promotion rename. */
const INSTALL_STARTUP_BUDGET_MS = 5 * 60_000;
/**
 * Slowest sustained transfer the install budget tolerates: 1 MiB/s, about
 * 8 Mbit/s.
 */
export const INSTALL_MIN_BYTES_PER_SECOND = 1024 * 1024;
/**
 * Clamp on the manifest byte total, so a malformed manifest cannot mint an
 * unbounded timer. Twice the largest artifact the macOS catalog ships
 * (qwen3-asr-1.7b-mlx-bf16, 4,080,710,353 bytes).
 */
export const INSTALL_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * A model install is a multi-gigabyte download, so a constant budget is a
 * throughput requirement in disguise.
 *
 * The budget was a flat 20 minutes for every artifact. Finishing inside it
 * therefore demanded 20.6 Mbit/s for whisper-large-v3 (3,083,520,685 bytes) and
 * 27.2 Mbit/s for qwen3-asr-1.7b bf16 (4,080,710,353 bytes), with zero margin
 * for TLS, verification, or a slow mirror. Below that, the timeout terminated
 * the worker mid-download and the next attempt started over, so the flagship
 * tiers could not be installed at all on an ordinary home or tethered link.
 *
 * This is a stall backstop, not a deadline: `huggingface_hub`'s own socket
 * timeouts fail a genuinely dead transfer long before this fires. Sizing it
 * from the artifact keeps the requirement at a fixed floor throughput rather
 * than one that rises with model size.
 */
export function installTimeoutMs(artifactBytes: number): number {
  const bounded = Math.max(0, Math.min(artifactBytes, INSTALL_MAX_ARTIFACT_BYTES));
  return INSTALL_STARTUP_BUDGET_MS
    + Math.ceil(bounded / INSTALL_MIN_BYTES_PER_SECOND) * 1000;
}

/**
 * How long one transcribe request may take before the worker is treated as
 * wedged.
 *
 * Inference cost scales with audio length, so a constant budget cannot cover a
 * maximum-length dictation: the original flat 120 s was already too small for a
 * 600 s recording on the fastest Apple silicon available (measured 135.6 s).
 * The replacement over-corrected in the other direction by multiplying the
 * duration by a speed multiple it had mistaken for a realtime factor, giving a
 * 121-minute ceiling.
 *
 * Both failures are user-visible in the same way: on a timeout the supervisor
 * terminates the worker, the caller deletes the WAV, and the recording is
 * unrecoverable — but one destroys valid dictations and the other lets a hung
 * one sit for two hours. A watchdog must never decide a valid dictation is
 * lost, and must still fire while the user is plausibly still waiting.
 *
 * Cancellation is unaffected and remains immediate: `abort()` does not queue
 * behind this timer.
 */
export function transcribeTimeoutMs(durationMs: number): number {
  const bounded = Math.max(0, Math.min(durationMs, AUDIO_MAX_DURATION_MS));
  return Math.min(
    TRANSCRIBE_TIMEOUT_CEILING_MS,
    TRANSCRIBE_COLD_LOAD_BUDGET_MS + bounded * TRANSCRIBE_REALTIME_FACTOR_BUDGET,
  );
}

const computeTypeSchema = z.enum([
  "float16",
  "int8",
  "int4",
  "bfloat16",
  "coreml-fp16",
  "coreml-int8",
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
  asrMode: asrModeSchema,
  loadMs: z.number().nonnegative(),
}).strict();

const liveStartedMessageSchema = z.object({
  type: z.literal("live_started"),
  id: z.string().uuid(),
}).strict();

const liveCancelledMessageSchema = z.object({
  type: z.literal("live_cancelled"),
  id: z.string().uuid(),
}).strict();

const partialMessageSchema = z.object({
  type: z.literal("partial"),
  id: z.string().uuid(),
  text: z.string().max(100_000),
}).strict();

const modelInstalledMessageSchema = z.object({
  type: z.literal("model_installed"),
  id: z.string().uuid(),
  tier: modelPerformanceTierSchema,
  modelId: z.string().min(1).max(200),
  computeType: computeTypeSchema,
  installMs: z.number().nonnegative(),
}).strict();

/**
 * Intermediate install events have the request id of their eventual
 * `model_installed` response. They are deliberately limited to byte counters
 * observed by the worker's downloader or digest reader, never estimates.
 */
const modelInstallProgressMessageSchema = z.object({
  type: z.literal("model_install_progress"),
  id: z.string().uuid(),
  phase: z.enum(["downloading", "verifying"]),
  completedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().positive(),
}).strict().superRefine((progress, context) => {
  if (progress.completedBytes > progress.totalBytes) {
    context.addIssue({
      code: "custom",
      path: ["completedBytes"],
      message: "Worker install progress exceeds its declared total.",
    });
  }
});
export type WorkerModelInstallProgress = z.infer<typeof modelInstallProgressMessageSchema>;

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
}).strict().refine(
  (message) => (
    message.hardware.unifiedMemory.availableBytes
    <= message.hardware.unifiedMemory.totalBytes
  ),
  "Available unified memory cannot exceed total unified memory.",
);

const workerMessageSchema = z.union([
  helloMessageSchema,
  modelReadyMessageSchema,
  modelInstalledMessageSchema,
  modelInstallProgressMessageSchema,
  liveStartedMessageSchema,
  liveCancelledMessageSchema,
  partialMessageSchema,
  z.object({
    type: z.literal("health"),
    id: z.string().uuid(),
    ready: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("final"),
    id: z.string().uuid(),
    text: z.string().max(100_000),
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
]);

type WorkerMessage = z.infer<typeof workerMessageSchema>;

interface PendingRequest {
  resolve(message: WorkerMessage): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout | null;
  /** Resets the stall watchdog only after the worker has made real progress. */
  armTimeout(): void;
  onInstallProgress?: (progress: WorkerModelInstallProgress) => void;
  lastInstallProgress?: WorkerModelInstallProgress;
  installProgressPhaseTransitions: number;
}

export interface WorkerModelSelection {
  modelId: string;
  tier: ModelPerformanceTier;
  computeType: WorkerComputeType;
  /** Legacy callers imply the original After I stop contract. */
  asrMode?: AsrMode;
}

export function workerModelSelectionsMatch(
  left: WorkerModelSelection | null,
  right: WorkerModelSelection,
): boolean {
  return left?.modelId === right.modelId
    && left.tier === right.tier
    && left.computeType === right.computeType
    && modeFor(left) === modeFor(right);
}

export interface WorkerTranscription {
  text: string;
  language: string | null;
  inferenceMs: number;
}

export interface WorkerAcceleratorSnapshot {
  kind: "apple-unified";
  displayName: string;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  memoryBasis: "estimated";
  sourceBasis: "vm_stat_free_inactive_speculative";
}

// Both workers permit up to 100,000 result characters. JSON control-character
// escaping can expand one character to six bytes, so the supervisor's byte
// boundary must exceed that valid worker output while remaining bounded.
const MAX_WORKER_STDOUT_LINE_BYTES = 1024 * 1024;
/** Runtime worker rejects larger base64-decoded Live audio payloads. */
export const LIVE_WORKER_MAX_CHUNK_BYTES = 8 * 1024;

/*
 * A worker may have both a launcher (`uv`) and native-runtime descendants.
 * Killing only the direct child can therefore leave Python or FluidAudio
 * resident after a model replacement or application quit. On POSIX, a
 * detached spawn makes the child the leader of a new process group; retaining
 * that exact leader pid lets shutdown address the whole app-owned tree.
 */
const WORKER_TERM_GRACE_MS = 1_000;
const WORKER_KILL_GRACE_MS = 1_000;
const WORKER_EXIT_POLL_MS = 25;

interface RetiringProcess {
  completion: Promise<void>;
  resolve(): void;
}

interface ActiveLiveSession {
  readonly sessionId: string;
  phase: "open" | "finishing" | "cancelled";
  nextSequence: number;
  nextPartialSequence: number;
  latestPartialText: string;
  chunks: Buffer[];
  chunkBytes: number;
  onPartial?: (partial: WorkerLivePartial) => void;
}

/** Ordered replacement snapshots from a single active Live worker session. */
export interface WorkerLivePartial {
  sessionId: string;
  sequence: number;
  text: string;
}

/**
 * A streaming decoder's final flush is authoritative when it contains text.
 * If a runtime has already emitted a non-empty cumulative transcript but its
 * final flush unexpectedly returns empty, retain that same decoder result so
 * the completed Live dictation can still follow the normal insertion/history
 * path. This never substitutes a model or invents text.
 */
export function completedLiveText(finalText: string, latestPartialText: string): string {
  return finalText.trim() ? finalText : latestPartialText;
}

export const WORKER_RUNTIME_IDENTITIES = {
  localscribe_worker: {
    backend: "localscribe-mlx-asr",
    version: "mlx-whisper/0.4.3;mlx-audio/0.4.6",
    acceleratorKind: "apple-unified",
  },
} as const;

/**
 * Tag a supervisor-level failure with the diagnostic code it represents.
 *
 * The worker's own failures arrive as a structured `code` in the protocol, but
 * these three are facts about the child process rather than replies from it, so
 * they had no code at all. The diagnostics log recorded them as `Error:len21`
 * and `Error:len32`, which made a crashed worker and a wedged one look like the
 * same anonymous failure in a bug report. The message is unchanged — it is what
 * the user sees — and the code is what the log records.
 */
function workerProcessError(message: string, code: "worker_exited" | "worker_timeout"): Error {
  return Object.assign(new Error(message), { code });
}

export class WorkerSupervisor {
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly retiringProcesses = new Map<
    ChildProcessWithoutNullStreams,
    RetiringProcess
  >();
  private readonly processGroupIds = new WeakMap<ChildProcessWithoutNullStreams, number>();
  private readonly pending = new Map<string, PendingRequest>();
  private hello: Promise<void> | null = null;
  private resolveHello: (() => void) | null = null;
  private rejectHello: ((error: Error) => void) | null = null;
  private stdoutBuffer = Buffer.alloc(0);
  private activeModel: WorkerModelSelection | null = null;
  private liveSession: ActiveLiveSession | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private retired = false;

  constructor(
    private readonly workerDirectory: string,
    private readonly modelRoot: string,
    private readonly environmentDirectory: string,
    private readonly bundledRuntimeDirectory: string | null = null,
    private readonly workerModule = "localscribe_worker",
    private readonly temporaryDirectory: string | null = null,
    /*
     * Where CPython may keep compiled bytecode.
     *
     * Left null, the worker runs exactly as it always has: `-B` plus
     * `PYTHONDONTWRITEBYTECODE`, recompiling every module on every start. That
     * default is not laziness — the worker's sources live in the packaged
     * Resources tree, which is covered by the startup integrity hash and is
     * code-signed, so letting Python drop `__pycache__` next to them would add
     * files to a protected tree and make the *next* launch fail verification.
     * `.pyc` is on the forbidden packaged-resource list for the same reason.
     *
     * Given a directory outside that tree, the cache is safe and the saving is
     * large: importing the ML stack is 1,492 modules, measured at 2.11-2.86s
     * every single model load without a cache and 0.70-0.87s with a warm one.
     */
    private readonly bytecodeCacheDirectory: string | null = null,
  ) {
    if (temporaryDirectory !== null && !path.isAbsolute(temporaryDirectory)) {
      throw new Error("ASR worker temporary storage must be an absolute path");
    }
    if (bytecodeCacheDirectory !== null) {
      if (!path.isAbsolute(bytecodeCacheDirectory)) {
        throw new Error("ASR worker bytecode cache must be an absolute path");
      }
      /*
       * The one thing that must never happen. A cache inside the worker or
       * bundled-runtime tree would corrupt the integrity expectation the next
       * launch checks, turning a startup optimisation into a build that
       * refuses to start.
       */
      for (const protectedRoot of [workerDirectory, bundledRuntimeDirectory]) {
        if (protectedRoot === null) continue;
        const relative = path.relative(protectedRoot, bytecodeCacheDirectory);
        if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) {
          throw new Error(
            "ASR worker bytecode cache must not live inside the packaged resource tree",
          );
        }
        if (path.resolve(protectedRoot) === path.resolve(bytecodeCacheDirectory)) {
          throw new Error(
            "ASR worker bytecode cache must not live inside the packaged resource tree",
          );
        }
      }
    }
  }

  /**
   * Gate that must pass before a *working* model is unloaded for a different
   * one. Injected rather than imported so the supervisor keeps no dependency on
   * the catalog, and so tests can drive both outcomes directly.
   *
   * Left unset the supervisor behaves as before, which is why main sets it
   * during startup and `tests/modelSwitchSafety.test.ts` pins that it does.
   */
  private assertTargetLoadable: ((selection: WorkerModelSelection) => Promise<void>) | null = null;

  setTargetLoadableGuard(
    guard: (selection: WorkerModelSelection) => Promise<void>,
  ): void {
    this.assertTargetLoadable = guard;
  }

  ensureReady(selection: WorkerModelSelection): Promise<void> {
    return this.serialize(() => this.ensureReadyUnlocked(selection));
  }

  /**
   * Returns the model held by the live worker without starting, probing, or
   * stopping anything. Main uses this to keep diagnostics observational and
   * to restore the previous warm runtime if an Apply transaction fails.
   */
  loadedSelection(): WorkerModelSelection | null {
    return this.activeModel ? { ...this.activeModel } : null;
  }

  /**
   * Installs and verifies model data without changing the selected runtime.
   * An unrelated warm model stays resident in the same serialized worker. A
   * repair that replaces the warm artifact must explicitly request an unload;
   * after the transaction the prior selection is loaded again.
   *
   * There is intentionally no public cancel operation. This isolated worker
   * owns both the installer and any warm native runtime, so the only reliable
   * interruption is process termination, which would evict an unrelated warm
   * model. The worker's atomic staging/recovery protocol makes an interrupted
   * install safe to retry; exposing a "Cancel" button here would falsely
   * promise that it could preserve the warm runtime.
   */
  installModel(
    selection: WorkerModelSelection,
    options: {
      replacesLoadedArtifact?: boolean;
      artifactBytes?: number;
      onProgress?: (progress: WorkerModelInstallProgress) => void;
    } = {},
  ): Promise<void> {
    return this.serialize(async () => {
      const previousSelection = this.activeModel ? { ...this.activeModel } : null;
      const mustUnload = previousSelection !== null
        && (options.replacesLoadedArtifact === true || sameSelection(previousSelection, selection));
      if (mustUnload) await this.stopProcessUnlocked();
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
          installTimeoutMs(options.artifactBytes ?? INSTALL_MAX_ARTIFACT_BYTES),
          options.onProgress,
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
        if (!previousSelection) {
          // A data-only installer process must not become an accidental warm
          // runtime when the application was cold before the operation.
          await this.stopProcessUnlocked();
        } else if (mustUnload) {
          // Finish the installer process before reconstructing the exact prior
          // selection, so replacement never overlaps the old native runtime.
          await this.stopProcessUnlocked();
          // Never rebuild a runtime the application is in the middle of
          // discarding: Quit during a repair would otherwise wait out a full
          // multi-gigabyte load before the process could exit.
          if (!this.retired) await this.ensureReadyUnlocked(previousSelection);
        }
      }
    });
  }

  transcribe(input: {
    model: WorkerModelSelection;
    audioPath: string;
    allowedRoot: string;
    language: string;
    context: string;
    durationMs: number;
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
        transcribeTimeoutMs(input.durationMs),
      );
      if (response.type !== "final") {
        const error = new Error(`Unexpected worker response: ${response.type}`);
        this.abort(error.message);
        throw error;
      }
      return {
        text: response.text,
        language: response.language ?? null,
        inferenceMs: response.inferenceMs,
      };
    });
  }

  /**
   * Opens one mode-specific Live decoder. The worker owns no renderer session
   * identity, so the supervisor carries it and rejects stale/late frames
   * before they can reach the line protocol.
   */
  beginLive(input: {
    session: LiveAudioSessionDescriptor;
    model: WorkerModelSelection;
    language: string;
    context: string;
    onPartial?: (partial: WorkerLivePartial) => void;
  }): Promise<LiveAudioSink> {
    return this.serialize(async () => {
      if (modeFor(input.model) !== "live") {
        throw new Error("Live dictation requires a live model selection");
      }
      if (this.liveSession) throw new Error("Live dictation is already active");
      await this.ensureReadyUnlocked(input.model);
      const response = await this.request({
        type: "begin_live",
        language: input.language,
        context: input.context,
      }, 30_000);
      if (!liveStartedMessageSchema.safeParse(response).success) {
        this.abort("ASR worker rejected live dictation startup");
        throw new Error(`Unexpected worker response: ${response.type}`);
      }
      const active: ActiveLiveSession = {
        sessionId: input.session.sessionId,
        phase: "open",
        nextSequence: 0,
        nextPartialSequence: 0,
        latestPartialText: "",
        chunks: [],
        chunkBytes: 0,
        onPartial: input.onPartial,
      };
      this.liveSession = active;
      return {
        write: (frame) => this.writeLiveFrame(active, frame),
        finish: () => this.finishLive(active),
        abort: () => this.cancelLive(active),
      };
    });
  }

  private writeLiveFrame(active: ActiveLiveSession, frame: LivePcmFrame): Promise<void> {
    if (this.liveSession !== active || active.phase !== "open") {
      return Promise.reject(new Error("Live dictation was cancelled"));
    }
    if (
      frame.sequence !== active.nextSequence
      || frame.sampleRateHz !== 16_000
      || frame.channels !== 1
      || frame.sampleCount !== LIVE_AUDIO_FRAME_SAMPLES
      || frame.pcm.byteLength !== LIVE_AUDIO_FRAME_SAMPLES * 2
    ) {
      this.cancelLiveNow(active);
      return Promise.reject(new Error("Live audio frame violated the local protocol"));
    }
    active.nextSequence += 1;
    const chunk = Buffer.from(frame.pcm);
    if (active.chunkBytes + chunk.byteLength > LIVE_WORKER_MAX_CHUNK_BYTES) {
      this.cancelLiveNow(active);
      return Promise.reject(new Error("Live audio chunk exceeded the local protocol limit"));
    }
    active.chunks.push(chunk);
    active.chunkBytes += chunk.byteLength;
    // Aggregate only complete PCM frames and cap at the exact Python limit.
    if (active.chunkBytes + LIVE_AUDIO_FRAME_SAMPLES * 2 > LIVE_WORKER_MAX_CHUNK_BYTES) {
      return this.serialize(() => this.flushLive(active));
    }
    return Promise.resolve();
  }

  private finishLive(active: ActiveLiveSession): Promise<void> {
    if (this.liveSession !== active || active.phase !== "open") {
      return Promise.reject(new Error("Live dictation was cancelled"));
    }
    active.phase = "finishing";
    return this.serialize(async () => {
      if (this.liveSession !== active) throw new Error("Live dictation was cancelled");
      await this.flushLive(active);
      const response = await this.request({ type: "finish_live" }, TRANSCRIBE_TIMEOUT_CEILING_MS);
      if (response.type !== "final") {
        this.abort("ASR worker returned an invalid live final response");
        throw new Error(`Unexpected worker response: ${response.type}`);
      }
      this.liveSession = null;
    });
  }

  /** Returns the Live final while retaining the sink-compatible finish API above. */
  finishLiveWithResult(sessionId: string): Promise<WorkerTranscription> {
    const active = this.liveSession;
    if (!active || active.sessionId !== sessionId || active.phase !== "open") {
      return Promise.reject(new Error("Live dictation was cancelled"));
    }
    active.phase = "finishing";
    return this.serialize(async () => {
      if (this.liveSession !== active) throw new Error("Live dictation was cancelled");
      await this.flushLive(active);
      const response = await this.request({ type: "finish_live" }, TRANSCRIBE_TIMEOUT_CEILING_MS);
      if (response.type !== "final") {
        this.abort("ASR worker returned an invalid live final response");
        throw new Error(`Unexpected worker response: ${response.type}`);
      }
      this.liveSession = null;
      return {
        text: completedLiveText(response.text, active.latestPartialText),
        language: response.language ?? null,
        inferenceMs: response.inferenceMs,
      };
    });
  }

  cancelLiveSession(sessionId: string): Promise<void> {
    const active = this.liveSession;
    if (!active || active.sessionId !== sessionId) return Promise.resolve();
    return this.cancelLive(active);
  }

  private cancelLive(active: ActiveLiveSession): Promise<void> {
    this.cancelLiveNow(active);
    return this.serialize(async () => {
      const response = await this.request({ type: "cancel_live" }, 5_000);
      if (!liveCancelledMessageSchema.safeParse(response).success) {
        this.abort("ASR worker rejected live cancellation");
        throw new Error(`Unexpected worker response: ${response.type}`);
      }
    });
  }

  private cancelLiveNow(active: ActiveLiveSession): void {
    if (active.phase === "cancelled") return;
    active.phase = "cancelled";
    active.chunks.length = 0;
    active.chunkBytes = 0;
    if (this.liveSession === active) this.liveSession = null;
  }

  private async flushLive(active: ActiveLiveSession): Promise<void> {
    if (this.liveSession !== active || active.phase === "cancelled") {
      throw new Error("Live dictation was cancelled");
    }
    if (active.chunkBytes === 0) return;
    const audioBase64 = Buffer.concat(active.chunks, active.chunkBytes).toString("base64");
    active.chunks.length = 0;
    active.chunkBytes = 0;
    const response = await this.request({ type: "append_live", audioBase64 }, 30_000);
    // `cancelLiveSession` invalidates the session before it queues cleanup,
    // so an append already in flight can still return. Its response must be
    // rejected rather than treated as success, and it must never become a
    // preview or final result after local cancellation.
    if (this.liveSession !== active) {
      throw new Error("Live dictation was cancelled");
    }
    const partial = partialMessageSchema.safeParse(response);
    if (!partial.success) {
      this.abort("ASR worker returned an invalid live partial response");
      throw new Error(`Unexpected worker response: ${response.type}`);
    }
    if (partial.data.text.trim()) active.latestPartialText = partial.data.text;
    // Partial transcripts are decoder snapshots, not append-only deltas. They
    // are emitted only while this exact live session remains open; the partial
    // returned while flushing during finalization is intentionally discarded
    // because the final response becomes the authoritative transcript.
    if (active.phase === "open") {
      try {
        active.onPartial?.({
          sessionId: active.sessionId,
          sequence: active.nextPartialSequence++,
          text: partial.data.text,
        });
      } catch (error) {
        // Preview delivery is observational. A renderer handoff must never
        // discard audio or abort an otherwise healthy local dictation.
        console.warn("LocalScribe could not deliver a Live transcript preview", error);
      }
    }
  }

  deviceInfo(): Promise<WorkerAcceleratorSnapshot> {
    return this.serialize(async () => {
      await this.ensureStarted();
      const response = await this.request({ type: "device_info" }, 30_000);
      const identity = WORKER_RUNTIME_IDENTITIES[
        this.workerModule as keyof typeof WORKER_RUNTIME_IDENTITIES
      ];
      if (identity?.acceleratorKind === "apple-unified") {
        const mac = macDeviceInfoMessageSchema.safeParse(response);
        if (!mac.success) {
          const error = new Error(
            "ASR worker reported accelerator telemetry for the wrong runtime platform",
          );
          this.abort(error.message);
          throw error;
        }
        const memory = mac.data.hardware.unifiedMemory;
        return {
          kind: "apple-unified",
          // Hardware fact only. The engine suffix is appended once, by
          // acceleratorDiagnostics() in main; baking " · MLX" into the
          // fallback rendered "Apple Silicon GPU · MLX · MLX" whenever the
          // sysctl chip-brand probe failed.
          displayName: mac.data.hardware.chip ?? "Apple Silicon GPU",
          totalMemoryBytes: memory.totalBytes,
          freeMemoryBytes: memory.availableBytes,
          memoryBasis: "estimated",
          sourceBasis: memory.memoryBasis,
        };
      }
      const error = new Error(`ASR worker has no accelerator policy: ${this.workerModule}`);
      this.abort(error.message);
      throw error;
    });
  }

  shutdown(): Promise<void> {
    return this.serialize(() => this.stopProcessUnlocked());
  }

  /**
   * Latches the supervisor closed because the application is quitting.
   *
   * `shutdown()` is serialized, so it waits behind whatever model operation is
   * already running. A repair of the warm artifact restores the previous
   * selection in its `finally`, which meant choosing Quit during a repair
   * spawned a fresh Python process and loaded a multi-gigabyte model that the
   * next queued operation would immediately discard — while the UI was already
   * refusing IPC. After this call, no path starts a worker process again.
   */
  retire(): void {
    this.retired = true;
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
      /*
       * Prove the target before discarding what works.
       *
       * The unload below is irreversible within this operation: it kills the
       * Python process, which is the "never two large models resident"
       * guarantee, and the target's pinned digests are not checked until the
       * `load_model` request further down. So for the window between those two
       * points the application has destroyed a working runtime on the strength
       * of nothing at all — and a corrupted-but-same-size artifact used to make
       * it all the way here, because the only upstream guard compared sizes.
       *
       * `assertTargetLoadable` closes that window. It throws before anything is
       * stopped, so a target that cannot be proved good leaves the warm model
       * exactly as it was and the caller sees the failure with dictation still
       * possible.
       */
      await this.assertTargetLoadable?.(selection);
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
          asrMode: modeFor(selection),
          modelRoot: this.modelRoot,
          // Normal inference must never fetch weights. Model data is only
          // acquired through the explicit `install_model` operation above.
          allowDownload: false,
        },
        20 * 60_000,
      );
    } catch (error) {
      // Model-load failures can leave a partially initialized native
      // state even when the worker returned a structured error. Never reuse
      // that process for a later selection.
      this.abort(error instanceof Error ? error.message : "ASR model load failed");
      if (error instanceof Error && error.message.includes("model_not_installed")) {
        throw new Error(
          "Local speech model is not installed. Open LocalScribe Settings > Model & Performance to install it before dictating.",
          { cause: error },
        );
      }
      throw error;
    }
    const ready = modelReadyMessageSchema.safeParse(response);
    if (!ready.success) {
      const error = new Error(`Unexpected worker response: ${response.type}`);
      this.abort(error.message);
      throw error;
    }
    if (
      ready.data.modelId !== selection.modelId
      || ready.data.tier !== selection.tier
      || ready.data.computeType !== selection.computeType
      || ready.data.asrMode !== modeFor(selection)
    ) {
      const error = new Error(
        "ASR worker acknowledged a model selection other than the validated catalog tier",
      );
      this.abort(error.message);
      throw error;
    }
    this.activeModel = { ...selection };
  }

  private async ensureStarted(): Promise<void> {
    await this.waitForRetiringProcesses();
    if (this.process && this.hello) return this.hello;
    // A retired supervisor must not leave a Python child behind for a quit
    // that has already started tearing the application down.
    if (this.retired) throw new Error("LocalScribe is shutting down");
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
    /*
     * `-B` is the argument form of PYTHONDONTWRITEBYTECODE, so it has to go
     * whenever a cache directory is configured — leaving it would silently
     * cancel the cache and keep paying the full recompile.
     */
    const noBytecode = this.bytecodeCacheDirectory === null ? ["-B"] : [];
    const args = bundledPython
      ? [...noBytecode, "-m", this.workerModule]
      : ["run", "--project", this.workerDirectory, "python", ...noBytecode, "-m", this.workerModule];
    const child = spawn(
      command,
      args,
      {
        cwd: this.workerDirectory,
        env: this.workerEnvironment(Boolean(bundledPython)),
        // POSIX `detached` creates a new session and process group. The pipes
        // remain referenced, so this does not let the worker outlive Electron;
        // it gives termination a safe, dedicated group to signal. Windows has
        // different detached-process semantics and uses the direct-child
        // fallback below even though the current product target is macOS.
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const childPid = child.pid;
    if (
      process.platform !== "win32"
      && Number.isSafeInteger(childPid)
      && (childPid ?? 0) > 1
      && childPid !== process.pid
    ) {
      this.processGroupIds.set(child, childPid as number);
    }
    this.process = child;
    this.stdoutBuffer = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => this.handleStdoutChunk(child, chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      console.error(`[asr-worker] ${chunk.toString("utf8").trimEnd()}`);
    });
    child.on("error", (error) => {
      // A spawn error such as ENOENT has no OS process to terminate. Node
      // leaves pid/exitCode unset in that case, so tracking it as live would
      // permanently block a later retry. Errors after a pid was assigned do
      // require the normal whole-tree retirement path.
      if (child.pid === undefined) this.handleExit(child, error);
      else this.terminateWorker(child, error);
    });
    child.on("exit", (code, signal) =>
      this.terminateWorker(
        child,
        workerProcessError(`ASR worker exited (${code ?? signal ?? "unknown"})`, "worker_exited"),
      ),
    );

    const startupTimeout = setTimeout(() => {
      this.terminateWorker(
        child,
        workerProcessError("ASR worker did not start in time", "worker_timeout"),
      );
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
      ...(this.bytecodeCacheDirectory === null
        ? { PYTHONDONTWRITEBYTECODE: "1" }
        // Redirects every __pycache__ write out of the signed resource tree and
        // into one app-owned directory, keyed by source path.
        : { PYTHONPYCACHEPREFIX: this.bytecodeCacheDirectory }),
      // Keep the local worker's text protocol explicitly UTF-8.
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8:strict",
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
    if (this.temporaryDirectory) {
      // Do not forward ambient TEMP/TMP values into the restricted worker.
      // Main supplies a freshly-created app-owned directory, which prevents
      // Python or native dependencies from falling back to an unwritable
      // packaged-resource/current-working directory.
      environment.TMPDIR = this.temporaryDirectory;
      environment.TEMP = this.temporaryDirectory;
      environment.TMP = this.temporaryDirectory;
      // Keep Hugging Face/Xet transfer metadata out of the user's ambient
      // profile and inside the same app-owned cache removed after shutdown.
      environment.HF_HOME = path.join(this.temporaryDirectory, "huggingface");
      environment.HF_HUB_CACHE = path.join(
        this.temporaryDirectory,
        "huggingface",
        "hub",
      );
      environment.HF_XET_CACHE = path.join(
        this.temporaryDirectory,
        "huggingface",
        "xet",
      );
    }
    return environment;
  }

  private findBundledPython(): string | null {
    const root = this.bundledRuntimeDirectory;
    if (!root || !existsSync(root)) return null;
    const executable = "python3";
    const bundledVenv = path.join(root, "venv", "bin", executable);
    if (existsSync(bundledVenv)) return bundledVenv;
    const direct = path.join(root, "bin", executable);
    if (existsSync(direct)) return direct;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name, "bin", executable);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  private request(
    payload: Record<string, unknown>,
    timeoutMs: number,
    onInstallProgress?: (progress: WorkerModelInstallProgress) => void,
  ): Promise<WorkerMessage> {
    const child = this.process;
    if (!child) return Promise.reject(new Error("ASR worker is not running"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        timeout: null,
        armTimeout: () => {
          if (pending.timeout) clearTimeout(pending.timeout);
          pending.timeout = setTimeout(() => {
            if (!this.pending.has(id) || this.process !== child) return;
            // A timeout leaves the worker's execution state unknowable: it may
            // still be loading a model, reading an audio file, or downloading
            // data. Terminate the whole process so no later serialized operation
            // can accidentally reuse that stale state.
            this.terminateWorker(
              child,
              workerProcessError(`ASR worker request timed out: ${String(payload.type)}`, "worker_timeout"),
            );
          }, timeoutMs);
          pending.timeout.unref();
        },
        onInstallProgress,
        installProgressPhaseTransitions: 0,
      };
      this.pending.set(id, pending);
      pending.armTimeout();
      try {
        child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`, (error) => {
          if (!error || this.process !== child) return;
          // A broken stdin makes the process unusable and its execution state
          // unknowable. Reject every pending operation and force the next
          // serialized request to start a fresh worker.
          this.terminateWorker(child, error);
        });
      } catch (error) {
        this.terminateWorker(
          child,
          error instanceof Error ? error : new Error("ASR worker stdin write failed"),
        );
      }
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
      const expectedIdentity = WORKER_RUNTIME_IDENTITIES[
        this.workerModule as keyof typeof WORKER_RUNTIME_IDENTITIES
      ];
      if (
        !expectedIdentity
        || message.backend !== expectedIdentity.backend
        || message.version !== expectedIdentity.version
      ) {
        this.terminateWorker(
          child,
          new Error(
            `ASR worker identity mismatch for ${this.workerModule}: `
            + `received ${message.backend}@${message.version}`,
          ),
        );
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
    if (!pending) {
      this.terminateWorker(
        child,
        new Error("ASR worker emitted a response for an unknown request"),
      );
      return;
    }

    if (message.type === "model_install_progress") {
      const previous = pending.lastInstallProgress;
      const regressed = previous
        && (
          (previous.phase === message.phase
            && (
              previous.totalBytes !== message.totalBytes
              || previous.completedBytes > message.completedBytes
            ))
        );
      if (regressed) {
        this.terminateWorker(
          child,
          new Error("ASR worker emitted non-monotonic model-install progress"),
        );
        return;
      }
      if (previous && previous.phase !== message.phase) {
        pending.installProgressPhaseTransitions += 1;
        /*
         * A repair legitimately follows this bounded sequence:
         * verify existing data -> download replacement -> verify staging.
         * More transitions cannot describe this transaction and would let a
         * malformed worker keep resetting the stall watchdog without bytes.
         */
        if (pending.installProgressPhaseTransitions > 2) {
          this.terminateWorker(
            child,
            new Error("ASR worker emitted an invalid model-install progress phase sequence"),
          );
          return;
        }
      }
      pending.lastInstallProgress = message;
      // A static installer timeout still protects a silent or wedged worker.
      // Only a byte increase or one of the bounded phase transitions buys more
      // time, so a compromised worker cannot prevent timeout by endlessly
      // repeating a counter or flipping phases.
      if (
        !previous
        || previous.phase !== message.phase
        || previous.completedBytes !== message.completedBytes
      ) {
        pending.armTimeout();
      }
      try {
        pending.onInstallProgress?.(message);
      } catch (error) {
        this.terminateWorker(
          child,
          error instanceof Error
            ? error
            : new Error("Model-install progress handler rejected worker output"),
        );
      }
      return;
    }

    if (pending.timeout) clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.type === "error") {
      pending.reject(new Error(`${message.code}: ${message.message}`));
    } else {
      pending.resolve(message);
    }
  }

  private async stopProcessUnlocked(): Promise<void> {
    const child = this.process;
    if (!child) {
      await this.waitForRetiringProcesses();
      return;
    }
    try {
      await this.request({ type: "shutdown" }, 2_000);
    } catch {
      // The process is force-killed below if it does not acknowledge shutdown.
    }
    if (!(await this.waitForProcessTreeExit(child, 250))) {
      this.terminateWorker(child, new Error("ASR worker did not shut down cleanly"));
    }
    if (this.process === child) this.resetProcessState();
    await this.waitForRetiringProcesses();
  }

  private terminateWorker(child: ChildProcessWithoutNullStreams, error: Error): void {
    this.handleExit(child, error);
    if (this.isProcessTreeAlive(child)) {
      this.trackRetiringProcess(child);
    } else {
      this.completeRetirement(child);
    }
  }

  private trackRetiringProcess(child: ChildProcessWithoutNullStreams): void {
    if (this.retiringProcesses.has(child)) return;
    let resolveCompletion: (() => void) | null = null;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const retirement: RetiringProcess = {
      completion,
      resolve: () => resolveCompletion?.(),
    };
    this.retiringProcesses.set(child, retirement);

    void this.retireProcessTree(child, retirement);
  }

  private async waitForRetiringProcesses(): Promise<void> {
    for (const child of this.retiringProcesses.keys()) {
      if (!this.isProcessTreeAlive(child)) this.completeRetirement(child);
    }
    const active = [...this.retiringProcesses.values()];
    if (active.length > 0) {
      await Promise.race([
        Promise.all(active.map(({ completion }) => completion)),
        delay(WORKER_TERM_GRACE_MS + WORKER_KILL_GRACE_MS + 100),
      ]);
    }
    for (const child of this.retiringProcesses.keys()) {
      if (!this.isProcessTreeAlive(child)) this.completeRetirement(child);
    }
    if (this.retiringProcesses.size > 0) {
      throw new Error(
        "The previous ASR worker could not be terminated; refusing to start an overlapping model process",
      );
    }
  }

  private async retireProcessTree(
    child: ChildProcessWithoutNullStreams,
    retirement: RetiringProcess,
  ): Promise<void> {
    this.signalProcessTree(child, "SIGTERM");
    if (!(await this.waitForProcessTreeExit(child, WORKER_TERM_GRACE_MS))) {
      this.signalProcessTree(child, "SIGKILL");
      await this.waitForProcessTreeExit(child, WORKER_KILL_GRACE_MS);
    }
    if (!this.isProcessTreeAlive(child)) {
      this.completeRetirement(child, retirement);
    }
    // A process tree that survives SIGKILL intentionally remains tracked. A
    // model replacement is refused instead of overlapping two large runtimes
    // or pretending shutdown completed.
  }

  private completeRetirement(
    child: ChildProcessWithoutNullStreams,
    expected?: RetiringProcess,
  ): void {
    const retirement = this.retiringProcesses.get(child);
    if (!retirement || (expected && retirement !== expected)) return;
    this.retiringProcesses.delete(child);
    retirement.resolve();
  }

  private async waitForProcessTreeExit(
    child: ChildProcessWithoutNullStreams,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.isProcessTreeAlive(child)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await delay(Math.min(WORKER_EXIT_POLL_MS, remaining));
    }
    return true;
  }

  private isProcessTreeAlive(child: ChildProcessWithoutNullStreams): boolean {
    const processGroupId = this.ownedProcessGroupId(child);
    if (processGroupId !== null) {
      try {
        // Signal zero performs existence/permission checking without changing
        // process state. EPERM still proves that the group exists.
        process.kill(-processGroupId, 0);
        return true;
      } catch (error) {
        return !isErrnoWithCode(error, "ESRCH");
      }
    }
    return child.exitCode === null && child.signalCode === null;
  }

  private signalProcessTree(
    child: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals,
  ): void {
    const processGroupId = this.ownedProcessGroupId(child);
    if (processGroupId !== null) {
      try {
        process.kill(-processGroupId, signal);
        return;
      } catch (error) {
        if (isErrnoWithCode(error, "ESRCH")) return;
        // If group delivery itself is denied, still attempt to stop the
        // direct child. The tracked live-group check prevents replacement
        // from proceeding while any descendant remains.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // The bounded live-tree check below is authoritative. A failed signal
      // never gets rounded into a successful shutdown.
    }
  }

  private ownedProcessGroupId(child: ChildProcessWithoutNullStreams): number | null {
    const processGroupId = this.processGroupIds.get(child);
    // Never derive a negative-pid target from mutable/unvalidated state. Only
    // the exact positive pid retained from our detached spawn is accepted.
    if (
      process.platform === "win32"
      || processGroupId === undefined
      || !Number.isSafeInteger(processGroupId)
      || processGroupId <= 1
      || processGroupId === process.pid
      || child.pid !== processGroupId
    ) {
      return null;
    }
    return processGroupId;
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.process !== child) return;
    for (const request of this.pending.values()) {
      if (request.timeout) clearTimeout(request.timeout);
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
    this.liveSession = null;
  }
}

function sameSelection(
  left: WorkerModelSelection | null,
  right: WorkerModelSelection,
): boolean {
  return left !== null
    && left.modelId === right.modelId
    && left.tier === right.tier
    && left.computeType === right.computeType
    && modeFor(left) === modeFor(right);
}

function modeFor(selection: WorkerModelSelection): AsrMode {
  return selection.asrMode ?? "after-stop";
}

function isErrnoWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    timeout.unref();
  });
}
