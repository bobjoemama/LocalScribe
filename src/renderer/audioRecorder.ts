import pcmWorkletUrl from "./pcm-worklet.ts?worker&url";
import {
  AUDIO_MAX_DURATION_MS,
  AUDIO_MAX_FILE_BYTES,
  AUDIO_SAMPLE_RATE_HZ,
} from "../shared/audioProtocol";

export interface CapturedAudio {
  wav: ArrayBuffer;
  durationMs: number;
}

export class RecorderCancelledError extends Error {
  constructor() {
    super("Recording was cancelled");
    this.name = "RecorderCancelledError";
  }
}

export function audioDurationLimitLabel(durationMs = AUDIO_MAX_DURATION_MS): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1_000));
  if (totalSeconds % 60 === 0) {
    const minutes = totalSeconds / 60;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `${totalSeconds} ${totalSeconds === 1 ? "second" : "seconds"}`;
}

function createCaptureLimitError(kind: "large" | "long"): Error {
  return new Error(
    `Recording is too ${kind}; please keep dictation under ${audioDurationLimitLabel()}`,
  );
}

export class AudioRecorder {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private chunks: Float32Array[] = [];
  private capturedSamples = 0;
  private capturedBytes = 0;
  private maxCapturedSamples = 0;
  private maxCapturedBytes = 0;
  private captureLimitError: Error | null = null;
  private startedAt = 0;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<CapturedAudio> | null = null;
  private cancelPromise: Promise<void> | null = null;
  private generation = 0;
  private smoothedLevel = 0;
  private lastLevelEmitAt = 0;
  private levelListener: (level: number) => void = () => undefined;

  setLevelListener(listener: (level: number) => void): void {
    this.levelListener = listener;
  }

  async start(deviceId: string | null): Promise<void> {
    const generation = ++this.generation;
    const pendingCancel = this.cancelPromise;
    if (pendingCancel) await pendingCancel;
    const pendingStop = this.stopPromise;
    if (pendingStop) {
      try {
        await pendingStop;
      } catch {
        // A failed or cancelled finalization still has to release its recorder
        // before a later session can acquire the microphone.
      }
    }
    if (generation !== this.generation) throw new RecorderCancelledError();
    if (this.context) return;
    const startPromise = this.startInternal(deviceId, generation);
    this.startPromise = startPromise;
    try {
      await startPromise;
    } catch (error) {
      await this.teardown();
      if (this.startPromise === startPromise) this.startPromise = null;
      if (generation !== this.generation) throw new RecorderCancelledError();
      throw error;
    }
  }

  private async startInternal(deviceId: string | null, generation: number): Promise<void> {
    this.chunks = [];
    this.resetCaptureLimit();
    const stream = await this.openInputStream(deviceId, generation);
    if (generation !== this.generation) {
      for (const track of stream.getTracks()) track.stop();
      throw new RecorderCancelledError();
    }
    this.stream = stream;
    const context = new AudioContext({ latencyHint: "interactive" });
    this.context = context;
    await context.audioWorklet.addModule(pcmWorkletUrl);
    if (generation !== this.generation) {
      await this.teardown();
      throw new RecorderCancelledError();
    }
    this.source = context.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(context, "localscribe-pcm", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });
    this.setCaptureLimit(context.sampleRate);
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const chunk = event.data;
      if (this.captureLimitError) return;
      const remainingSamples = this.maxCapturedSamples - this.capturedSamples;
      const remainingBytes = this.maxCapturedBytes - this.capturedBytes;
      if (chunk.length > remainingSamples || chunk.byteLength > remainingBytes) {
        this.captureLimitError = createCaptureLimitError("large");
        this.stopCaptureAtLimit();
        return;
      }
      this.chunks.push(chunk);
      this.capturedSamples += chunk.length;
      this.capturedBytes += chunk.byteLength;
      let energy = 0;
      for (const sample of chunk) energy += sample * sample;
      const rms = Math.sqrt(energy / Math.max(1, chunk.length));
      const measured = audioLevelFromRms(rms);
      this.smoothedLevel = measured > this.smoothedLevel
        ? measured
        : Math.max(0, this.smoothedLevel * 0.82);
      const now = performance.now();
      if (now - this.lastLevelEmitAt >= 32) {
        this.lastLevelEmitAt = now;
        this.levelListener(this.smoothedLevel);
      }
    };
    this.source.connect(this.node);
    this.startedAt = performance.now();
  }

  private async openInputStream(
    deviceId: string | null,
    generation: number,
  ): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia(audioConstraints(deviceId));
    } catch (error) {
      // Browser device identifiers can change after an unplug, a driver
      // update, or an OS privacy reset. Only that narrow stale-device failure
      // may fall back to the system default; permission, security, and hardware
      // errors must remain visible to the user.
      if (!deviceId || !isUnavailableInputDeviceError(error)) throw error;
      if (generation !== this.generation) throw new RecorderCancelledError();
      return navigator.mediaDevices.getUserMedia(audioConstraints(null));
    }
  }

  stop(): Promise<CapturedAudio> {
    if (this.stopPromise) return this.stopPromise;
    const operation = this.stopInternal();
    const tracked = operation.finally(() => {
      if (this.stopPromise === tracked) this.stopPromise = null;
    });
    this.stopPromise = tracked;
    return this.stopPromise;
  }

  private async stopInternal(): Promise<CapturedAudio> {
    await this.startPromise;
    if (!this.context || !this.stream) throw new Error("Recorder is not active");
    const durationMs = Math.max(1, Math.round(performance.now() - this.startedAt));
    const inputRate = this.context.sampleRate;
    this.source?.disconnect();
    this.node?.disconnect();
    for (const track of this.stream.getTracks()) track.stop();
    await this.context.close();

    const captureLimitError = this.captureLimitError;
    if (captureLimitError) {
      this.resetAfterStop();
      throw captureLimitError;
    }
    if (durationMs > AUDIO_MAX_DURATION_MS) {
      this.resetAfterStop();
      throw createCaptureLimitError("long");
    }
    const merged = merge(this.chunks);
    if (merged.length < Math.round(inputRate * 0.1)) {
      this.resetAfterStop();
      throw new Error("No usable audio was captured; hold the dictation key a little longer");
    }
    if (!hasUsableSpeechEnergy(merged, inputRate)) {
      this.resetAfterStop();
      throw new Error("No speech detected; try again a little closer to the microphone");
    }
    const samples = resample(merged, inputRate, AUDIO_SAMPLE_RATE_HZ);
    const wav = encodePcm16Wav(samples, AUDIO_SAMPLE_RATE_HZ);
    if (wav.byteLength > AUDIO_MAX_FILE_BYTES) {
      this.resetAfterStop();
      throw createCaptureLimitError("large");
    }
    this.resetAfterStop();
    return { wav, durationMs };
  }

  cancel(): Promise<void> {
    if (this.cancelPromise) return this.cancelPromise;
    const operation = this.cancelInternal();
    const tracked = operation.finally(() => {
      if (this.cancelPromise === tracked) this.cancelPromise = null;
    });
    this.cancelPromise = tracked;
    return this.cancelPromise;
  }

  private async cancelInternal(): Promise<void> {
    const pendingStart = this.startPromise;
    const pendingStop = this.stopPromise;
    this.generation += 1;
    if (pendingStop) {
      try {
        await pendingStop;
      } catch {
        // Cancellation owns cleanup after a failed finalization.
      }
    }
    await this.teardown();
    if (pendingStart) {
      try {
        await pendingStart;
      } catch {
        // A cancelled startup rejects after it has disposed any late resources.
      }
      await this.teardown();
    }
    if (this.startPromise === pendingStart) this.startPromise = null;
  }

  private async teardown(): Promise<void> {
    this.source?.disconnect();
    this.node?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    await this.context?.close();
    this.context = null;
    this.stream = null;
    this.source = null;
    this.node = null;
    this.chunks = [];
    this.resetCaptureLimit();
    this.smoothedLevel = 0;
    this.lastLevelEmitAt = 0;
    this.levelListener(0);
  }

  private setCaptureLimit(inputRate: number): void {
    const maxSamples = Math.floor((inputRate * AUDIO_MAX_DURATION_MS) / 1_000);
    const maxBytes = maxSamples * Float32Array.BYTES_PER_ELEMENT;
    if (
      !Number.isSafeInteger(maxSamples) ||
      maxSamples <= 0 ||
      !Number.isSafeInteger(maxBytes)
    ) {
      this.maxCapturedSamples = 0;
      this.maxCapturedBytes = 0;
      return;
    }
    this.maxCapturedSamples = maxSamples;
    this.maxCapturedBytes = maxBytes;
  }

  private stopCaptureAtLimit(): void {
    if (this.node) this.node.port.onmessage = null;
    this.source?.disconnect();
    this.node?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.smoothedLevel = 0;
    this.levelListener(0);
  }

  private resetAfterStop(): void {
    this.context = null;
    this.stream = null;
    this.source = null;
    this.node = null;
    this.chunks = [];
    this.startPromise = null;
    this.resetCaptureLimit();
  }

  private resetCaptureLimit(): void {
    this.capturedSamples = 0;
    this.capturedBytes = 0;
    this.maxCapturedSamples = 0;
    this.maxCapturedBytes = 0;
    this.captureLimitError = null;
  }
}

function audioConstraints(deviceId: string | null): MediaStreamConstraints {
  return {
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  };
}

export function isUnavailableInputDeviceError(error: unknown): boolean {
  if (!(error instanceof Error) && !(typeof DOMException !== "undefined" && error instanceof DOMException)) {
    return false;
  }
  return error.name === "NotFoundError" || error.name === "OverconstrainedError";
}

export function audioLevelFromRms(rms: number): number {
  if (!Number.isFinite(rms) || rms < 0.004) return 0;
  const decibels = 20 * Math.log10(Math.max(rms, 1e-7));
  return Math.max(0, Math.min(1, (decibels + 50) / 35));
}

export function hasUsableSpeechEnergy(samples: Float32Array, sampleRate: number): boolean {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || samples.length === 0) return false;
  const frameSize = Math.max(1, Math.round(sampleRate * 0.02));
  const totalFrames = Math.ceil(samples.length / frameSize);
  const requiredActiveFrames = Math.max(3, Math.ceil(totalFrames * 0.03));
  let activeFrames = 0;

  for (let offset = 0; offset < samples.length; offset += frameSize) {
    const end = Math.min(samples.length, offset + frameSize);
    let energy = 0;
    for (let index = offset; index < end; index += 1) {
      const sample = samples[index] ?? 0;
      energy += sample * sample;
    }
    const rms = Math.sqrt(energy / Math.max(1, end - offset));
    if (rms >= 0.006 && ++activeFrames >= requiredActiveFrames) return true;
  }
  return false;
}

function merge(chunks: Float32Array[]): Float32Array {
  const output = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

/**
 * Convert captured audio to the protocol's 16 kHz.
 *
 * The two directions need different treatment, and treating them the same
 * destroyed the recording.
 *
 * Down (the common case — the AudioContext follows the OS device, usually 44.1
 * or 48 kHz) averages each output sample's window of input samples, which is a
 * crude but real low-pass before decimation.
 *
 * Up is the case that was wrong. `AudioContext` is constructed without an
 * explicit `sampleRate`, so it inherits whatever the default input device
 * reports, and macOS drives a Bluetooth headset in HFP/CVSD mode at 8 kHz —
 * some USB speakerphones report 8 kHz too. With `ratio < 1` the window
 * `[floor(i*ratio), floor((i+1)*ratio))` is *empty* for roughly half the output
 * indices, so `sum` stayed 0 and the sample was written as `0 / max(1, 0)`. The
 * result was the microphone signal multiplied by an alternating 0/1 sequence:
 * amplitude modulation at Nyquist, which is severe aliasing plus a 6 dB drop,
 * on top of dropping half the information outright.
 *
 * Nothing caught it. `hasUsableSpeechEnergy` and the minimum-length check both
 * run on the *un*-resampled buffer, and the WAV header is written with the
 * literal 16000, so the mangled audio passed every validation layer and reached
 * the model as an ordinary recording. The user got "No speech detected" or a
 * nonsense transcript with nothing pointing at the sample rate.
 *
 * Linear interpolation is the fix: every output sample is derived from real
 * neighbouring input samples, so no sample is ever invented as silence.
 */
export function resample(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const output = new Float32Array(Math.max(0, Math.floor(input.length / ratio)));
  if (input.length === 0) return output;

  if (ratio < 1) {
    const last = input.length - 1;
    for (let index = 0; index < output.length; index += 1) {
      const position = index * ratio;
      const left = Math.min(last, Math.floor(position));
      const right = Math.min(last, left + 1);
      const weight = position - left;
      output[index] = (input[left] ?? 0) * (1 - weight) + (input[right] ?? 0) * weight;
    }
    return output;
  }

  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let source = start; source < end; source += 1) sum += input[source] ?? 0;
    output[index] = sum / Math.max(1, end - start);
  }
  return output;
}

function encodePcm16Wav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}
