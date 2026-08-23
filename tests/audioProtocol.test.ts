import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUDIO_BITS_PER_SAMPLE,
  AUDIO_CHANNELS,
  AUDIO_MAX_DURATION_MS,
  AUDIO_MAX_FILE_BYTES,
  AUDIO_PROTOCOL_VERSION,
  AUDIO_SAMPLE_RATE_HZ,
  ASR_MAX_CONTEXT_CHARS,
  isAudioProtocolWav,
} from "../src/shared/audioProtocol";
import { transcribeAudioSchema } from "../src/shared/contracts";

function makeProtocolWav(options: { frames?: number; sampleRate?: number; channels?: number; bits?: number } = {}): ArrayBuffer {
  const frames = options.frames ?? 160;
  const sampleRate = options.sampleRate ?? AUDIO_SAMPLE_RATE_HZ;
  const channels = options.channels ?? AUDIO_CHANNELS;
  const bits = options.bits ?? AUDIO_BITS_PER_SAMPLE;
  const bytesPerSample = bits / 8;
  const bytesPerFrame = channels * bytesPerSample;
  const dataBytes = frames * bytesPerFrame;
  const wav = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(wav);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  write(0, "RIFF");
  view.setUint32(4, wav.byteLength - 8, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerFrame, true);
  view.setUint16(32, bytesPerFrame, true);
  view.setUint16(34, bits, true);
  write(36, "data");
  view.setUint32(40, dataBytes, true);
  return wav;
}

function workerSource(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("audio protocol", () => {
  const sessionId = "00000000-0000-4000-8000-000000000001";

  it("accepts only the canonical mono 16 kHz PCM16 WAV layout", () => {
    expect(isAudioProtocolWav(makeProtocolWav())).toBe(true);
    expect(isAudioProtocolWav(makeProtocolWav({ sampleRate: 48_000 }))).toBe(false);
    expect(isAudioProtocolWav(makeProtocolWav({ channels: 2 }))).toBe(false);
    expect(isAudioProtocolWav(makeProtocolWav({ bits: 8 }))).toBe(false);
    expect(isAudioProtocolWav(new ArrayBuffer(44))).toBe(false);
  });

  it("enforces the same WAV and duration bounds at the renderer/main IPC boundary", () => {
    const wav = makeProtocolWav();
    expect(transcribeAudioSchema.parse({ sessionId, wav, durationMs: 10 }))
      .toEqual({ sessionId, wav, durationMs: 10 });
    expect(() => transcribeAudioSchema.parse({
      sessionId,
      wav: makeProtocolWav({ sampleRate: 44_100 }),
      durationMs: 10,
    })).toThrow("Recording must be mono 16 kHz PCM16 WAV");
    expect(() => transcribeAudioSchema.parse({
      sessionId,
      wav,
      durationMs: AUDIO_MAX_DURATION_MS + 1,
    })).toThrow();
  });

  it("keeps the packaged worker constants aligned to the manifest", () => {
    const expected = [
      `AUDIO_PROTOCOL_VERSION = ${AUDIO_PROTOCOL_VERSION}`,
      `MAX_AUDIO_BYTES = ${AUDIO_MAX_FILE_BYTES.toLocaleString("en-US").replaceAll(",", "_")}`,
      `MAX_AUDIO_DURATION_MS = ${AUDIO_MAX_DURATION_MS.toLocaleString("en-US").replaceAll(",", "_")}`,
      `MAX_CONTEXT_CHARS = ${ASR_MAX_CONTEXT_CHARS.toLocaleString("en-US").replaceAll(",", "_")}`,
      `REQUIRED_SAMPLE_RATE = ${AUDIO_SAMPLE_RATE_HZ.toLocaleString("en-US").replaceAll(",", "_")}`,
      `REQUIRED_CHANNELS = ${AUDIO_CHANNELS}`,
      `REQUIRED_SAMPLE_WIDTH_BYTES = ${AUDIO_BITS_PER_SAMPLE / 8}`,
    ];
    const source = workerSource("worker/localscribe_worker/worker.py");
    for (const constant of expected) expect(source).toContain(constant);
  });
});
