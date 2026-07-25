import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AudioRecorder,
  RecorderCancelledError,
  audioDurationLimitLabel,
  audioLevelFromRms,
  hasUsableSpeechEnergy,
  isUnavailableInputDeviceError,
} from "../src/renderer/audioRecorder";
import { AUDIO_MAX_DURATION_MS, isAudioProtocolWav } from "../src/shared/audioProtocol";

interface AudioHarness {
  closeContext: ReturnType<typeof vi.fn>;
  disconnectNode: ReturnType<typeof vi.fn>;
  disconnectSource: ReturnType<typeof vi.fn>;
  getUserMedia: ReturnType<typeof vi.fn>;
  port: { onmessage: ((event: MessageEvent<Float32Array>) => void) | null };
  stream: MediaStream;
  stopTrack: ReturnType<typeof vi.fn>;
}

function installAudioHarness(sampleRate: number): AudioHarness {
  const stopTrack = vi.fn();
  const disconnectSource = vi.fn();
  const disconnectNode = vi.fn();
  const closeContext = vi.fn().mockResolvedValue(undefined);
  const port: AudioHarness["port"] = { onmessage: null };
  const stream = {
    getTracks: () => [{ stop: stopTrack }],
  } as unknown as MediaStream;
  const source = {
    connect: vi.fn(),
    disconnect: disconnectSource,
  } as unknown as MediaStreamAudioSourceNode;

  class FakeAudioContext {
    readonly sampleRate = sampleRate;
    readonly audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    readonly close = closeContext;

    createMediaStreamSource(): MediaStreamAudioSourceNode {
      return source;
    }
  }

  class FakeAudioWorkletNode {
    readonly port = port;
    readonly disconnect = disconnectNode;
  }

  const getUserMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);

  return {
    closeContext,
    disconnectNode,
    disconnectSource,
    getUserMedia,
    port,
    stream,
    stopTrack,
  };
}

describe("audio waveform level", () => {
  it("keeps room noise quiet and maps speech RMS logarithmically", () => {
    expect(audioLevelFromRms(0)).toBe(0);
    expect(audioLevelFromRms(0.0039)).toBe(0);
    expect(audioLevelFromRms(0.01)).toBeCloseTo(2 / 7, 3);
    expect(audioLevelFromRms(0.1)).toBeCloseTo(6 / 7, 3);
    expect(audioLevelFromRms(1)).toBe(1);
    expect(audioLevelFromRms(Number.NaN)).toBe(0);
  });
});

describe("speech energy gate", () => {
  it("rejects silence and low room noise", () => {
    expect(hasUsableSpeechEnergy(new Float32Array(16_000), 16_000)).toBe(false);
    expect(hasUsableSpeechEnergy(new Float32Array(16_000).fill(0.003), 16_000)).toBe(false);
  });

  it("accepts a short speech-like signal without requiring continuous volume", () => {
    const samples = new Float32Array(16_000);
    for (let index = 2_000; index < 4_000; index += 1) {
      samples[index] = Math.sin(index / 7) * 0.025;
    }
    expect(hasUsableSpeechEnergy(samples, 16_000)).toBe(true);
  });
});

describe("AudioRecorder capture bounds", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stops accepting worklet chunks at the configured source sample and byte ceiling", async () => {
    const sampleRate = 100;
    const harness = installAudioHarness(sampleRate);
    const recorder = new AudioRecorder();
    await recorder.start(null);

    const maxSamples = sampleRate * AUDIO_MAX_DURATION_MS / 1_000;
    const atLimit = new Float32Array(maxSamples).fill(0.02);
    harness.port.onmessage?.({ data: atLimit } as MessageEvent<Float32Array>);

    const beforeOverflow = recorder as unknown as {
      capturedBytes: number;
      capturedSamples: number;
      chunks: Float32Array[];
    };
    expect(beforeOverflow.capturedSamples).toBe(maxSamples);
    expect(beforeOverflow.capturedBytes).toBe(atLimit.byteLength);
    expect(beforeOverflow.chunks).toEqual([atLimit]);
    expect(harness.stopTrack).not.toHaveBeenCalled();

    harness.port.onmessage?.({
      data: new Float32Array([0.02]),
    } as MessageEvent<Float32Array>);

    expect(harness.port.onmessage).toBeNull();
    expect(beforeOverflow.capturedSamples).toBe(maxSamples);
    expect(beforeOverflow.capturedBytes).toBe(atLimit.byteLength);
    expect(beforeOverflow.chunks).toEqual([atLimit]);
    expect(harness.disconnectSource).toHaveBeenCalledOnce();
    expect(harness.disconnectNode).toHaveBeenCalledOnce();
    expect(harness.stopTrack).toHaveBeenCalledOnce();

    await expect(recorder.stop()).rejects.toThrow(
      `Recording is too large; please keep dictation under ${audioDurationLimitLabel()}`,
    );
    expect(harness.closeContext).toHaveBeenCalledOnce();
  });

  it("keeps ordinary recordings in the canonical PCM16 WAV protocol", async () => {
    let now = 0;
    vi.stubGlobal("performance", { now: () => now });
    const harness = installAudioHarness(16_000);
    const recorder = new AudioRecorder();
    await recorder.start(null);

    const samples = new Float32Array(1_600);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.sin(index / 7) * 0.025;
    }
    now = 200;
    harness.port.onmessage?.({ data: samples } as MessageEvent<Float32Array>);

    const captured = await recorder.stop();
    expect(captured.durationMs).toBe(200);
    expect(captured.wav.byteLength).toBe(44 + samples.length * 2);
    expect(isAudioProtocolWav(captured.wav)).toBe(true);
  });

  it("rejects elapsed-time overflow before attempting to merge captured chunks", async () => {
    let now = 0;
    vi.stubGlobal("performance", { now: () => now });
    installAudioHarness(16_000);
    const recorder = new AudioRecorder();
    await recorder.start(null);

    now = AUDIO_MAX_DURATION_MS + 1;
    await expect(recorder.stop()).rejects.toThrow(
      `Recording is too long; please keep dictation under ${audioDurationLimitLabel()}`,
    );
  });

  it("derives visible capture limits from the shared audio protocol", () => {
    expect(audioDurationLimitLabel(60_000)).toBe("1 minute");
    expect(audioDurationLimitLabel(90_000)).toBe("90 seconds");
    const configuredMinutes = AUDIO_MAX_DURATION_MS / 60_000;
    expect(audioDurationLimitLabel()).toBe(
      `${configuredMinutes} ${configuredMinutes === 1 ? "minute" : "minutes"}`,
    );
  });
});

describe("AudioRecorder input selection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("falls back to the system default when a persisted device ID is stale", async () => {
    const harness = installAudioHarness(16_000);
    const unavailable = new Error("Selected microphone disappeared");
    unavailable.name = "OverconstrainedError";
    harness.getUserMedia
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce(harness.stream);

    const recorder = new AudioRecorder();
    await recorder.start("stale-device-id");

    expect(harness.getUserMedia).toHaveBeenCalledTimes(2);
    expect(harness.getUserMedia.mock.calls[0]?.[0]).toMatchObject({
      audio: { deviceId: { exact: "stale-device-id" } },
    });
    expect(harness.getUserMedia.mock.calls[1]?.[0]).toMatchObject({
      audio: { deviceId: undefined },
    });
    await recorder.cancel();
  });

  it("does not hide microphone permission or hardware failures behind fallback", async () => {
    const harness = installAudioHarness(16_000);
    const denied = new Error("Microphone permission was denied");
    denied.name = "NotAllowedError";
    harness.getUserMedia.mockRejectedValueOnce(denied);

    const recorder = new AudioRecorder();
    await expect(recorder.start("selected-device")).rejects.toBe(denied);
    expect(harness.getUserMedia).toHaveBeenCalledOnce();
    expect(isUnavailableInputDeviceError(denied)).toBe(false);
  });

  it.each(["NotFoundError", "OverconstrainedError"])(
    "recognizes %s as a stale device-selection error",
    (name) => {
      const error = new Error("unavailable");
      error.name = name;
      expect(isUnavailableInputDeviceError(error)).toBe(true);
    },
  );
});

describe("AudioRecorder cancellation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stops a microphone stream that resolves after cancellation", async () => {
    const stopTrack = vi.fn();
    let resolveStream!: (stream: MediaStream) => void;
    const streamPromise = new Promise<MediaStream>((resolve) => {
      resolveStream = resolve;
    });
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(() => streamPromise) },
    });

    const recorder = new AudioRecorder();
    const starting = recorder.start(null);
    const cancelling = recorder.cancel();
    resolveStream({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);

    await cancelling;
    await expect(starting).rejects.toBeInstanceOf(RecorderCancelledError);
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("does not surface a late microphone rejection after cancellation", async () => {
    let rejectStream!: (error: Error) => void;
    const streamPromise = new Promise<MediaStream>((_resolve, reject) => {
      rejectStream = reject;
    });
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(() => streamPromise) },
    });

    const recorder = new AudioRecorder();
    const starting = recorder.start(null);
    const cancelling = recorder.cancel();
    rejectStream(new Error("Late device failure"));

    await cancelling;
    await expect(starting).rejects.toBeInstanceOf(RecorderCancelledError);
  });

  it("does not open the default microphone after a stale-device failure is cancelled", async () => {
    let rejectStream!: (error: Error) => void;
    const streamPromise = new Promise<MediaStream>((_resolve, reject) => {
      rejectStream = reject;
    });
    const getUserMedia = vi.fn(() => streamPromise);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    const recorder = new AudioRecorder();
    const starting = recorder.start("stale-device");
    const cancelling = recorder.cancel();
    const unavailable = new Error("Selected microphone disappeared");
    unavailable.name = "NotFoundError";
    rejectStream(unavailable);

    await cancelling;
    await expect(starting).rejects.toBeInstanceOf(RecorderCancelledError);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("waits for cancellation cleanup before starting the next recording", async () => {
    const stopTrack = vi.fn();
    let resolveFirst!: (stream: MediaStream) => void;
    const firstStream = new Promise<MediaStream>((resolve) => {
      resolveFirst = resolve;
    });
    const nextFailure = new Error("Second microphone attempt");
    const getUserMedia = vi.fn()
      .mockImplementationOnce(() => firstStream)
      .mockRejectedValueOnce(nextFailure);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    const recorder = new AudioRecorder();
    const starting = recorder.start(null);
    const cancelling = recorder.cancel();
    const restarting = recorder.start(null);
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    resolveFirst({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
    await cancelling;
    await expect(starting).rejects.toBeInstanceOf(RecorderCancelledError);
    await expect(restarting).rejects.toBe(nextFailure);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("starts a real recorder after cancelling an in-flight finalization", async () => {
    let now = 0;
    vi.stubGlobal("performance", { now: () => now });
    let releaseFirstClose!: () => void;
    const firstClose = new Promise<void>((resolve) => {
      releaseFirstClose = resolve;
    });
    const closeContext = [
      vi.fn(() => firstClose),
      vi.fn().mockResolvedValue(undefined),
    ];
    const ports = [
      { onmessage: null as ((event: MessageEvent<Float32Array>) => void) | null },
      { onmessage: null as ((event: MessageEvent<Float32Array>) => void) | null },
    ];
    const tracks = [vi.fn(), vi.fn()];
    const streams = tracks.map((stop) => ({
      getTracks: () => [{ stop }],
    })) as unknown as MediaStream[];
    const sources = [0, 1].map(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
    })) as unknown as MediaStreamAudioSourceNode[];
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce(streams[0])
      .mockResolvedValueOnce(streams[1]);
    let contextIndex = 0;
    let nodeIndex = 0;

    class FakeAudioContext {
      readonly index = contextIndex++;
      readonly sampleRate = 16_000;
      readonly audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };

      createMediaStreamSource(): MediaStreamAudioSourceNode {
        return sources[this.index]!;
      }

      close(): Promise<void> {
        return closeContext[this.index]!();
      }
    }

    class FakeAudioWorkletNode {
      readonly port = ports[nodeIndex++]!;
      readonly disconnect = vi.fn();
    }

    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);

    const recorder = new AudioRecorder();
    await recorder.start(null);
    const samples = new Float32Array(1_600);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.sin(index / 7) * 0.025;
    }
    now = 200;
    ports[0]!.onmessage?.({ data: samples } as MessageEvent<Float32Array>);

    const finalizing = recorder.stop();
    await vi.waitFor(() => expect(closeContext[0]).toHaveBeenCalledOnce());
    const cancelling = recorder.cancel();
    const restarting = recorder.start(null);
    expect(getUserMedia).toHaveBeenCalledOnce();

    releaseFirstClose();
    await finalizing;
    await cancelling;
    await restarting;

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(contextIndex).toBe(2);
    expect(ports[1]!.onmessage).toBeTypeOf("function");

    now = 400;
    ports[1]!.onmessage?.({ data: samples } as MessageEvent<Float32Array>);
    await expect(recorder.stop()).resolves.toMatchObject({ durationMs: 200 });
  });
});
