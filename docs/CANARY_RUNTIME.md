# Canary-Qwen 2.5B on Apple Silicon

Canary is an optional English-only **After I stop** model. Parakeet remains the
fresh-install default and the Live option. Canary does not expose live partials,
timestamps, translation, or generative rewriting. Dictionary/snippet corrections
still run centrally after the final transcript; recognition prompts are disabled.

| Profile | Pinned GGUF | Download bytes |
| --- | --- | ---: |
| High | BF16, unquantized | 5,076,107,136 |
| Medium | Q8_0 | 2,797,548,928 |
| Low | Q4_K_M | 1,737,575,808 |

Auto uses the existing hardware/memory policy within this family. Working-set
figures are conservative estimates, not measurements or accuracy claims.

## Ownership and packaging

The existing Python worker loads a small C ABI library using stdlib `ctypes`.
No new Python package, inference server, listening port, executable model plugin,
or hidden download path is added. The library statically embeds transcribe.cpp,
GGML, and Metal shaders; remaining dependencies must be Apple system libraries.
Metal is required, with no silent CPU or different-model fallback.

`tools/canary-runtime/pin.json` pins the upstream commit and source archive SHA-256.
`bash scripts/build-canary-runtime.sh` compiles only runtime code, without model
downloads. The normal worker build invokes it. Forge promotes the staged dylib,
signs it with the runtime entitlement policy, and includes it in resource integrity,
inventory, source provenance, and the runtime SBOM. The staging restore mechanism
does not replace the installed application.
Source development can use the generated staging library; packaged lookup never
searches outside its Resources root. Native source builds require CMake 3.24+ and
the Apple command-line toolchain, neither of which is needed by app users.

Each GGUF has a separate immutable manifest, directory, byte count, and SHA-256.
The normal explicit download/atomic install/verification/Apply path is reused.
The worker accepts only a curated selection and a verified local artifact.
Weights remain warm between dictations. Decoder sessions are freed on every
chunk, including errors. Switch/cancel/quit use the existing worker supervisor;
terminating the worker also terminates native inference inside it.

## Long recordings and proof boundary

Recordings longer than 30 seconds are partitioned into <=30-second chunks,
preferring low-energy boundaries. Every input sample is used exactly once.
Chunks are joined into **one final** result; no partial insertion/history writes
occur. Context is capped at 2,048 tokens per chunk. Native truncation or invalid
output fails the whole request rather than publishing a partial success.
Chunk boundaries can affect recognition quality; this has not been measured.

Implementation checks cover catalog/mode contracts, fake native output and
failure paths, chunk accounting, native compilation/linkage, and the existing
application regressions. These do not prove actual Canary recognition quality,
latency, physical microphone/paste behavior, or a signed packaged Canary run.
No model weights or benchmark workloads are required by those checks.

Sources:
- [Pinned runtime](https://github.com/handy-computer/transcribe.cpp/tree/e2f82cb6702315a1194f3bf1a6fee67cd2678447)
- [Pinned GGUF artifacts](https://huggingface.co/handy-computer/canary-qwen-2.5b-gguf/tree/3370d4e2f28cc70eea79dfc9f2f43fb91eef3163)
- [Original NVIDIA model](https://huggingface.co/nvidia/canary-qwen-2.5b)

See `THIRD_PARTY_NOTICES.md` for runtime and weight attribution.
