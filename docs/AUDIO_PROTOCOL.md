# Audio protocol

`resources/audio-protocol.json` is the canonical manifest for audio passed
from the Electron renderer to LocalScribe's local workers:

- canonical WAV container with mono, 16 kHz, signed PCM16 frames;
- a maximum duration and total file-byte limit.

`src/shared/audioProtocol.ts` is the Electron-facing authority and is used by
the recorder and IPC schema. The macOS MLX Whisper and Windows faster-whisper workers
keep literal constants rather than importing application code, because each is
packaged as a standalone Python runtime. `tests/audioProtocol.test.ts` checks
those literals against the manifest on every TypeScript test run. Update the
manifest and both worker constants together; do not add a runtime
cross-language import.
