# Audio protocol

`resources/audio-protocol.json` is the canonical manifest for audio passed
from the Electron renderer to LocalScribe's local macOS worker:

- canonical WAV container;
- mono, 16 kHz, signed PCM16 frames;
- maximum duration and total file-byte limits.

`src/shared/audioProtocol.ts` is the Electron-facing authority used by capture
and IPC validation. The packaged Python worker keeps literal constants because
it runs as a standalone runtime. `tests/audioProtocol.test.ts` checks those
constants against the manifest. Update the manifest and worker constants
together; do not add a runtime cross-language source import.

## Dictionary recognizer hints

`maxAsrContextChars` (4,000) is the protocol ceiling for a dictionary hint, not
a promise that every backend consumes it. MLX Whisper passes the hint as
`initial_prompt` and its decoder retains the tail of the permitted prompt
window.

`buildDictionaryAsrContext` therefore emits selected terms lowest-priority
first so the highest-priority terms remain at the end. Changing that order can
cause the decoder to discard the newest/highest-priority entries;
`tests/dictionaryContext.test.ts` pins the surviving tail.

Parakeet does not advertise recognizer-context support, so LocalScribe sends it
an empty context. Deterministic Dictionary and snippet correction still runs
after transcription. Capability-aware routing must remain authoritative: a
backend never receives an unsupported prompt merely because the protocol has a
global ceiling.
