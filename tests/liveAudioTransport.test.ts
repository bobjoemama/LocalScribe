import { describe, expect, it, vi } from "vitest";
import {
  LIVE_AUDIO_FRAME_SAMPLES,
  LiveAudioBackpressureError,
  LivePcmFrameEncoder,
  LivePcmTransport,
  assertLiveAudioAdapter,
  liveAudioAvailability,
  openLiveAudioIpcSink,
} from "../src/shared/liveAudioTransport";

describe("Live audio adapter gate", () => {
  it("does not advertise Live without an actual adapter", () => {
    expect(liveAudioAvailability(null)).toEqual({
      available: false,
      reason: "This speech model does not have a local Live adapter installed.",
    });
    expect(() => assertLiveAudioAdapter(undefined)).toThrow("no local Live adapter");
  });
});

describe("Live PCM framing", () => {
  it("keeps frame boundaries and resampling continuity across chunks", () => {
    const encoder = new LivePcmFrameEncoder(8_000);
    const input = new Float32Array(200);
    for (let index = 0; index < input.length; index += 1) input[index] = index / 200;

    const first = encoder.push(input.subarray(0, 100));
    const second = encoder.push(input.subarray(100));
    const final = encoder.finish();
    const frames = [...first, ...second, ...final];
    const sampleCount = frames.reduce((sum, frame) => sum + frame.sampleCount, 0);

    // 200 samples at 8 kHz become just under 400 samples at 16 kHz; the last
    // tail is padded to preserve the fixed 20 ms wire-frame contract.
    expect(sampleCount).toBe(640);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ sampleCount: LIVE_AUDIO_FRAME_SAMPLES });
    expect(frames[0]?.pcm.byteLength).toBe(LIVE_AUDIO_FRAME_SAMPLES * 2);
    expect(frames[1]?.sampleCount).toBe(LIVE_AUDIO_FRAME_SAMPLES);
    expect(frames[1]?.pcm.byteLength).toBe(LIVE_AUDIO_FRAME_SAMPLES * 2);
  });
});

describe("Live transport backpressure and cancellation", () => {
  it("keeps the future preload bridge audio-only and final-only", async () => {
    const beginLiveAudio = vi.fn().mockResolvedValue(undefined);
    const pushLiveAudio = vi.fn().mockResolvedValue(undefined);
    const finishLiveAudio = vi.fn().mockResolvedValue(undefined);
    const cancelLiveAudio = vi.fn().mockResolvedValue(undefined);
    const sink = await openLiveAudioIpcSink({
      beginLiveAudio,
      pushLiveAudio,
      finishLiveAudio,
      cancelLiveAudio,
    }, {
      sessionId: "00000000-0000-4000-8000-000000000001",
      protocolVersion: 1,
      sampleRateHz: 16_000,
      channels: 1,
    });
    const controller = new AbortController();
    await sink.write({
      sequence: 0,
      sampleRateHz: 16_000,
      channels: 1,
      sampleCount: 320,
      pcm: new ArrayBuffer(640),
    }, controller.signal);
    await sink.finish(controller.signal);
    await sink.abort?.(new Error("cancelled"));

    expect(beginLiveAudio).toHaveBeenCalledOnce();
    expect(pushLiveAudio).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "00000000-0000-4000-8000-000000000001",
      sequence: 0,
    }));
    expect(finishLiveAudio).toHaveBeenCalledOnce();
    expect(finishLiveAudio).toHaveBeenCalledWith({
      sessionId: "00000000-0000-4000-8000-000000000001",
    });
    expect(cancelLiveAudio).toHaveBeenCalledWith({
      sessionId: "00000000-0000-4000-8000-000000000001",
      reason: "cancelled",
    });
  });

  it("fails instead of silently dropping frames when an adapter falls behind", async () => {
    let releaseWrite!: () => void;
    const writing = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const failure = vi.fn();
    const transport = new LivePcmTransport({
      write: () => writing,
      finish: vi.fn(),
    }, { maxPendingFrames: 1, onFailure: failure });

    const frame = () => new ArrayBuffer(LIVE_AUDIO_FRAME_SAMPLES * 2);
    expect(transport.offer(frame(), LIVE_AUDIO_FRAME_SAMPLES)).toBe(true);
    expect(transport.offer(frame(), LIVE_AUDIO_FRAME_SAMPLES)).toBe(true);
    expect(transport.offer(frame(), LIVE_AUDIO_FRAME_SAMPLES)).toBe(false);
    expect(transport.failed).toBeInstanceOf(LiveAudioBackpressureError);
    expect(failure).toHaveBeenCalledOnce();

    releaseWrite();
    await expect(transport.finish()).rejects.toBeInstanceOf(LiveAudioBackpressureError);
  });

  it("aborts the sink and prevents queued audio after cancellation", async () => {
    let resolveWrite!: () => void;
    const writing = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const write = vi.fn(() => writing);
    const abort = vi.fn();
    const transport = new LivePcmTransport({ write, finish: vi.fn(), abort });

    expect(transport.offer(new ArrayBuffer(640), 320)).toBe(true);
    expect(transport.offer(new ArrayBuffer(640), 320)).toBe(true);
    await transport.cancel();
    resolveWrite();
    await Promise.resolve();

    expect(abort).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    expect(transport.pendingFrames).toBe(0);
  });
});
