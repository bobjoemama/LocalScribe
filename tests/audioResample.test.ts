import { describe, expect, it } from "vitest";

import { hasUsableSpeechEnergy, resample } from "../src/renderer/audioRecorder";
import { isAudioProtocolWav } from "../src/shared/audioProtocol";

/*
 * The recorder converts whatever the OS gives it to the protocol's 16 kHz.
 * Upsampling used to write a literal zero for roughly every other output
 * sample, because the averaging window `[floor(i*r), floor((i+1)*r))` is empty
 * when `r < 1`. That happens with an 8 kHz Bluetooth HFP headset — a normal
 * macOS configuration — and every validation layer missed it: the energy and
 * length guards run on the *un*-resampled buffer, and the WAV header is written
 * with the literal 16000, so the mangled audio looked exactly like a good
 * recording all the way to the model.
 *
 * These tests assert on the samples the function actually produces. A test that
 * only checked the output length, or only ran at 16 kHz, would have passed
 * throughout.
 */

const TARGET_RATE = 16_000;

/** A 440 Hz tone: continuous, so any zero in the output is manufactured. */
function tone(sampleRate: number, milliseconds: number, hz = 440): Float32Array {
  const length = Math.round((sampleRate * milliseconds) / 1_000);
  const samples = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    samples[index] = 0.5 * Math.sin((2 * Math.PI * hz * index) / sampleRate);
  }
  return samples;
}

function rms(samples: Float32Array): number {
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  return Math.sqrt(energy / Math.max(1, samples.length));
}

function longestZeroRun(samples: Float32Array): number {
  let longest = 0;
  let run = 0;
  for (const sample of samples) {
    run = sample === 0 ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

function zeroCount(samples: Float32Array): number {
  let zeros = 0;
  for (const sample of samples) if (sample === 0) zeros += 1;
  return zeros;
}

describe("upsampling to the protocol rate", () => {
  /*
   * THE DEFECT, at the exact rate macOS uses for narrowband Bluetooth. Before
   * the fix this produced a zero at every even index — half the recording.
   */
  it("does not zero every other sample at 8 kHz", () => {
    const input = tone(8_000, 500);
    const output = resample(input, 8_000, TARGET_RATE);

    expect(output.length).toBe(input.length * 2);
    // A 440 Hz tone crosses zero about 440 times a second; at 16 kHz that is
    // well under 1% of samples, and never two in a row.
    expect(zeroCount(output)).toBeLessThan(output.length * 0.01);
    expect(longestZeroRun(output)).toBeLessThanOrEqual(1);
  });

  it("preserves the signal level rather than halving it", () => {
    const input = tone(8_000, 500);
    const output = resample(input, 8_000, TARGET_RATE);

    // The old implementation dropped ~6 dB by interleaving silence.
    expect(rms(output)).toBeGreaterThan(rms(input) * 0.9);
    expect(rms(output)).toBeLessThan(rms(input) * 1.1);
  });

  it.each([8_000, 11_025, 12_000, 15_999])(
    "produces continuous audio from %i Hz",
    (inputRate) => {
      const output = resample(tone(inputRate, 300), inputRate, TARGET_RATE);

      expect(output.length).toBeGreaterThan(0);
      expect(longestZeroRun(output)).toBeLessThanOrEqual(1);
      expect(rms(output)).toBeGreaterThan(rms(tone(inputRate, 300)) * 0.9);
    },
  );

  it("keeps the tone recognisable instead of aliasing it", () => {
    // Count sign changes: a 440 Hz tone has ~880 per second regardless of rate.
    // The old output alternated sign-ish at Nyquist, giving thousands.
    const output = resample(tone(8_000, 1_000), 8_000, TARGET_RATE);
    let crossings = 0;
    for (let index = 1; index < output.length; index += 1) {
      if (Math.sign(output[index] ?? 0) !== Math.sign(output[index - 1] ?? 0)) crossings += 1;
    }
    expect(crossings).toBeGreaterThan(800);
    expect(crossings).toBeLessThan(960);
  });

  it("interpolates between real neighbours", () => {
    // A ramp makes the arithmetic checkable by hand: doubling the rate should
    // put each new sample halfway between its neighbours.
    const input = Float32Array.from([0, 0.2, 0.4, 0.6]);
    const output = resample(input, 8_000, 16_000);

    expect(Array.from(output.slice(0, 6)).map((value) => Number(value.toFixed(4))))
      .toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
  });

  it("never reads past the end of the input", () => {
    const output = resample(Float32Array.from([1, 1, 1]), 8_000, 16_000);
    expect(output.length).toBe(6);
    expect(Array.from(output).every(Number.isFinite)).toBe(true);
    expect(output[5]).toBe(1);
  });
});

describe("downsampling and pass-through are unchanged", () => {
  it.each([44_100, 48_000, 96_000])("averages %i Hz down to the protocol rate", (inputRate) => {
    const input = tone(inputRate, 300);
    const output = resample(input, inputRate, TARGET_RATE);

    expect(output.length).toBe(Math.floor(input.length / (inputRate / TARGET_RATE)));
    expect(longestZeroRun(output)).toBeLessThanOrEqual(1);
    expect(rms(output)).toBeGreaterThan(rms(input) * 0.8);
  });

  it("returns the same buffer when the rates already match", () => {
    const input = tone(TARGET_RATE, 100);
    expect(resample(input, TARGET_RATE, TARGET_RATE)).toBe(input);
  });

  it("handles an empty buffer", () => {
    expect(resample(new Float32Array(0), 8_000, TARGET_RATE).length).toBe(0);
    expect(resample(new Float32Array(0), 48_000, TARGET_RATE).length).toBe(0);
  });
});

/*
 * Why the defect survived: none of the checks that stand between the microphone
 * and the model can see it. This pins that, so the resampler is understood to
 * be the only thing protecting this path.
 */
describe("nothing downstream can detect corrupted resampling", () => {
  it("energy and protocol checks accept audio the old resampler would have ruined", () => {
    const input = tone(8_000, 500);
    // The energy guard runs on the input, at the device's own rate.
    expect(hasUsableSpeechEnergy(input, 8_000)).toBe(true);

    const zeroInterleaved = new Float32Array(input.length * 2);
    for (let index = 0; index < input.length; index += 1) {
      zeroInterleaved[index * 2 + 1] = input[index] ?? 0;
    }
    const wav = new ArrayBuffer(44 + zeroInterleaved.length * 2);
    const view = new DataView(wav);
    for (const [offset, ascii] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]] as const) {
      for (let index = 0; index < ascii.length; index += 1) {
        view.setUint8(offset + index, ascii.charCodeAt(index));
      }
    }
    view.setUint32(4, 36 + zeroInterleaved.length * 2, true);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, TARGET_RATE, true);
    view.setUint32(28, TARGET_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    view.setUint32(40, zeroInterleaved.length * 2, true);
    for (let index = 0; index < zeroInterleaved.length; index += 1) {
      const sample = zeroInterleaved[index] ?? 0;
      view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }

    // Half of this buffer is manufactured silence, and the protocol validator
    // has no way to know. It checks the header, which says 16 kHz mono PCM.
    expect(isAudioProtocolWav(wav)).toBe(true);
  });
});
