declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][]): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
): void;

class LocalScribePcmProcessor extends AudioWorkletProcessor {
  /*
   * AudioWorklet renders 128-frame quanta.  Sending every quantum causes up
   * to 375 renderer messages/second on a 48 kHz microphone.  A small reusable
   * ring-style buffer reduces that boundary to ~50 messages/second at the
   * requested 16 kHz rate while remaining far below perceptible Live latency.
   */
  private readonly pending = new Float32Array(320);
  private pendingLength = 0;

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel?.length) return true;
    let offset = 0;
    while (offset < channel.length) {
      const writable = this.pending.length - this.pendingLength;
      const count = Math.min(writable, channel.length - offset);
      this.pending.set(channel.subarray(offset, offset + count), this.pendingLength);
      this.pendingLength += count;
      offset += count;
      if (this.pendingLength === this.pending.length) {
        const output = this.pending.slice();
        this.port.postMessage(output, [output.buffer]);
        this.pendingLength = 0;
      }
    }
    return true;
  }
}

registerProcessor("localscribe-pcm", LocalScribePcmProcessor);
