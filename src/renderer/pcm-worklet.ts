declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][]): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
): void;

class LocalScribePcmProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (channel?.length) this.port.postMessage(channel.slice());
    return true;
  }
}

registerProcessor("localscribe-pcm", LocalScribePcmProcessor);
