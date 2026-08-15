import {
  AUDIO_BYTES_PER_FRAME,
  AUDIO_PROTOCOL_VERSION,
  AUDIO_SAMPLE_RATE_HZ,
} from "./audioProtocol";

/**
 * Canonical audio emitted while a Live dictation is in progress.
 *
 * This is intentionally audio-only.  A Live inference adapter may use the
 * frames to form provisional text, but neither this transport nor its callers
 * have an insertion capability.  LocalScribe inserts one final result only
 * after the user stops dictating.
 */
export interface LivePcmFrame {
  readonly sequence: number;
  readonly sampleRateHz: typeof AUDIO_SAMPLE_RATE_HZ;
  readonly channels: 1;
  readonly sampleCount: 320;
  readonly pcm: ArrayBuffer;
}

export interface LiveAudioSessionDescriptor {
  readonly sessionId: string;
  readonly protocolVersion: typeof AUDIO_PROTOCOL_VERSION;
  readonly sampleRateHz: typeof AUDIO_SAMPLE_RATE_HZ;
  readonly channels: 1;
}

/**
 * A real ASR backend implements this interface in main.  Renderer code only
 * receives a sink created from such an adapter; it cannot invent one from a
 * model label or an optimistic settings value.
 */
export interface LiveAudioSink {
  write(frame: LivePcmFrame, signal: AbortSignal): Promise<void> | void;
  finish(signal: AbortSignal): Promise<void> | void;
  abort?(reason: Error): Promise<void> | void;
}

export interface LiveAsrAdapter {
  readonly liveAudio: true;
  beginLiveAudio(session: LiveAudioSessionDescriptor): Promise<LiveAudioSink>;
}

/**
 * Typed shape for the narrow preload bridge that main will expose once a
 * native streaming helper is installed.  It deliberately has no partial-text
 * or insertion operation: partials stay inside main/the pill preview, and
 * final insertion remains the existing completed-dictation path.
 */
export interface LiveAudioIpcBridge {
  beginLiveAudio(session: LiveAudioSessionDescriptor): Promise<void>;
  pushLiveAudio(frame: LivePcmFrame & { readonly sessionId: string }): Promise<void>;
  finishLiveAudio(session: { readonly sessionId: string }): Promise<void>;
  cancelLiveAudio(session: { readonly sessionId: string; readonly reason: string }): Promise<void>;
}

export async function openLiveAudioIpcSink(
  bridge: LiveAudioIpcBridge,
  session: LiveAudioSessionDescriptor,
): Promise<LiveAudioSink> {
  await bridge.beginLiveAudio(session);
  return {
    write: (frame, signal) => {
      if (signal.aborted) return;
      return bridge.pushLiveAudio({ ...frame, sessionId: session.sessionId });
    },
    finish: (signal) => {
      if (signal.aborted) return;
      return bridge.finishLiveAudio({ sessionId: session.sessionId });
    },
    abort: (reason) => bridge.cancelLiveAudio({ sessionId: session.sessionId, reason: reason.message }),
  };
}

export interface LiveAudioAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

export function liveAudioAvailability(adapter: LiveAsrAdapter | null | undefined): LiveAudioAvailability {
  return adapter?.liveAudio === true
    ? { available: true }
    : { available: false, reason: "This speech model does not have a local Live adapter installed." };
}

export function assertLiveAudioAdapter(
  adapter: LiveAsrAdapter | null | undefined,
): asserts adapter is LiveAsrAdapter {
  if (!liveAudioAvailability(adapter).available) {
    throw new Error("Live dictation is unavailable because no local Live adapter is installed.");
  }
}

export class LiveAudioBackpressureError extends Error {
  constructor() {
    super("Live dictation could not keep up with microphone audio. Try a faster model or use After I stop mode.");
    this.name = "LiveAudioBackpressureError";
  }
}

export const LIVE_AUDIO_FRAME_SAMPLES = 320; // 20 ms at 16 kHz
export const LIVE_AUDIO_MAX_PENDING_FRAMES = 250; // five seconds, bounded by design

/**
 * Serializes an asynchronous inference sink without ever growing unbounded
 * renderer memory.  A slow or failed adapter stops capture rather than
 * dropping speech and falsely presenting an incomplete transcript as final.
 */
export class LivePcmTransport {
  private readonly controller = new AbortController();
  private readonly queue: LivePcmFrame[] = [];
  private readonly onFailure: (error: Error) => void;
  private draining: Promise<void> | null = null;
  private sequence = 0;
  private ending = false;
  private cancelled = false;
  private failure: Error | null = null;

  constructor(
    private readonly sink: LiveAudioSink,
    options: {
      readonly maxPendingFrames?: number;
      readonly onFailure?: (error: Error) => void;
    } = {},
  ) {
    this.maxPendingFrames = options.maxPendingFrames ?? LIVE_AUDIO_MAX_PENDING_FRAMES;
    this.onFailure = options.onFailure ?? (() => undefined);
  }

  private readonly maxPendingFrames: number;

  get failed(): Error | null {
    return this.failure;
  }

  get pendingFrames(): number {
    return this.queue.length;
  }

  /** Queue a canonical PCM16 frame. Returns false when capture must stop. */
  offer(pcm: ArrayBuffer, sampleCount: number): boolean {
    if (this.ending || this.cancelled || this.failure) return false;
    if (!isCanonicalFrame(pcm, sampleCount) || this.queue.length >= this.maxPendingFrames) {
      this.fail(new LiveAudioBackpressureError());
      return false;
    }
    this.queue.push({
      sequence: this.sequence++,
      sampleRateHz: AUDIO_SAMPLE_RATE_HZ,
      channels: 1,
      sampleCount,
      pcm,
    });
    this.ensureDrain();
    return true;
  }

  async finish(): Promise<void> {
    if (this.cancelled) return;
    this.ending = true;
    await this.draining;
    if (this.failure) throw this.failure;
    await this.sink.finish(this.controller.signal);
    if (this.failure) throw this.failure;
  }

  async cancel(reason = new Error("Live dictation was cancelled")): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    this.queue.length = 0;
    this.controller.abort(reason);
    try {
      await this.sink.abort?.(reason);
    } catch {
      // Cancellation must still release the microphone if an already-failed
      // helper cannot acknowledge its shutdown request.
    }
  }

  private ensureDrain(): void {
    if (this.draining) return;
    this.draining = this.drain().finally(() => {
      this.draining = null;
      if (this.queue.length > 0 && !this.cancelled && !this.failure) this.ensureDrain();
    });
  }

  private async drain(): Promise<void> {
    while (!this.cancelled && !this.failure) {
      const frame = this.queue.shift();
      if (!frame) return;
      try {
        await this.sink.write(frame, this.controller.signal);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("Live speech processing failed"));
      }
    }
  }

  private fail(error: Error): void {
    if (this.failure || this.cancelled) return;
    this.failure = error;
    this.queue.length = 0;
    this.controller.abort(error);
    this.onFailure(error);
  }
}

/** Converts arbitrary AudioWorklet-rate Float32 chunks to ordered PCM16 frames. */
export class LivePcmFrameEncoder {
  private readonly resampler: StreamingLinearResampler;
  private readonly frame = new Int16Array(LIVE_AUDIO_FRAME_SAMPLES);
  private frameOffset = 0;

  constructor(inputSampleRateHz: number) {
    if (!Number.isFinite(inputSampleRateHz) || inputSampleRateHz <= 0) {
      throw new Error("Audio input sample rate is invalid");
    }
    this.resampler = new StreamingLinearResampler(inputSampleRateHz, AUDIO_SAMPLE_RATE_HZ);
  }

  push(input: Float32Array): Array<{ pcm: ArrayBuffer; sampleCount: number }> {
    return this.pushSamples(this.resampler.push(input));
  }

  finish(): Array<{ pcm: ArrayBuffer; sampleCount: number }> {
    return this.pushSamples(this.resampler.finish(), true);
  }

  private pushSamples(
    samples: Float32Array,
    flush = false,
  ): Array<{ pcm: ArrayBuffer; sampleCount: number }> {
    const frames: Array<{ pcm: ArrayBuffer; sampleCount: number }> = [];
    for (let index = 0; index < samples.length; index += 1) {
      const value = Math.max(-1, Math.min(1, samples[index] ?? 0));
      this.frame[this.frameOffset++] = value < 0 ? value * 0x8000 : value * 0x7fff;
      if (this.frameOffset === this.frame.length) {
        frames.push({ pcm: this.frame.buffer.slice(0), sampleCount: this.frameOffset });
        this.frameOffset = 0;
      }
    }
    if (flush && this.frameOffset > 0) {
      // The wire contract is fixed-size 20 ms frames. Pad the final tail with
      // silence instead of weakening validation at every downstream boundary.
      this.frame.fill(0, this.frameOffset);
      frames.push({ pcm: this.frame.buffer.slice(0), sampleCount: this.frame.length });
      this.frameOffset = 0;
    }
    return frames;
  }
}

/**
 * Linear interpolation with sample continuity across worklet messages.  The
 * AudioContext requests 16 kHz, but macOS may expose a different device rate;
 * this preserves the canonical contract in that case rather than assuming the
 * request was honoured.
 */
class StreamingLinearResampler {
  private readonly ratio: number;
  private seen = 0;
  private nextPosition = 0;
  private previous = 0;

  constructor(inputRate: number, outputRate: number) {
    this.ratio = inputRate / outputRate;
  }

  push(input: Float32Array): Float32Array {
    if (input.length === 0) return input;
    if (this.ratio === 1) return input;
    const start = this.seen;
    const end = start + input.length;
    const output = new Float32Array(Math.ceil(input.length / this.ratio) + 2);
    let count = 0;
    while (this.nextPosition < end - 1) {
      const left = Math.floor(this.nextPosition);
      const right = left + 1;
      const leftSample = left < start ? this.previous : input[left - start] ?? 0;
      const rightSample = input[right - start] ?? 0;
      const fraction = this.nextPosition - left;
      output[count++] = leftSample * (1 - fraction) + rightSample * fraction;
      this.nextPosition += this.ratio;
    }
    this.previous = input[input.length - 1] ?? this.previous;
    this.seen = end;
    return output.slice(0, count);
  }

  finish(): Float32Array {
    return new Float32Array(0);
  }
}

function isCanonicalFrame(pcm: ArrayBuffer, sampleCount: number): sampleCount is 320 {
  return Number.isInteger(sampleCount)
    && sampleCount === LIVE_AUDIO_FRAME_SAMPLES
    && pcm.byteLength === sampleCount * AUDIO_BYTES_PER_FRAME;
}
