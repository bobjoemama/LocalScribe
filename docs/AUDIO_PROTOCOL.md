# Audio protocol

`resources/audio-protocol.json` is the canonical manifest for audio passed
from the Electron renderer to LocalScribe's local workers:

- canonical WAV container with mono, 16 kHz, signed PCM16 frames;
- a maximum duration and total file-byte limit.

## The dictionary recognizer hint

`maxAsrContextChars` (4,000) bounds the dictionary hint sent with each
`transcribe` request. That is a protocol ceiling, not a promise the backend will
read all of it: mlx-whisper passes the string as `initial_prompt` and its
decoder keeps only `prompt_tokens[-(n_text_ctx // 2 - 1):]` — 223 tokens for
large-v3, roughly a fifth of a full 4,000-character hint. The truncation takes
the **tail**.

`buildDictionaryAsrContext` therefore emits its selected terms
**lowest-priority first**, so the highest-priority terms are the ones at the end
that survive. Emitting newest-first — the order the function computes — meant
Whisper's own truncation discarded exactly the newest entries the builder had
prioritised. If you change that ordering, change it knowing which end the
consumer keeps; `tests/dictionaryContext.test.ts` pins the surviving tail rather
than just the selection.

`src/shared/audioProtocol.ts` is the Electron-facing authority and is used by
the recorder and IPC schema. The macOS MLX Whisper and Windows faster-whisper workers
keep literal constants rather than importing application code, because each is
packaged as a standalone Python runtime. `tests/audioProtocol.test.ts` checks
those literals against the manifest on every TypeScript test run. Update the
manifest and both worker constants together; do not add a runtime
cross-language import.
