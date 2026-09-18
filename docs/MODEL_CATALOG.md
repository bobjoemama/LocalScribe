# Curated macOS model catalog

LocalScribe ships a fixed catalog for Apple Silicon. **Parakeet Unified EN
0.6B** is the fresh-install recommendation: pinned Core ML artifacts support
English after-stop and Live dictation through FluidAudio and the Apple Neural
Engine. Existing valid selections are preserved.

Canary-Qwen 2.5B, Qwen3-ASR 0.6B, and Qwen3-ASR 1.7B are
curated after-stop alternatives. Qwen3-ASR 0.6B is a smaller candidate, not a
claim of measured superiority. Comparative accuracy, latency, and memory
remain real-device benchmark questions.

The Settings model sorter exposes estimated unified memory, exact download
sizes, and explicitly labeled published reference WER/speed. See
[comparison evidence and source verification](MODEL_COMPARISON_EVIDENCE.md)
for the pinned benchmark, coverage gaps, and Mac artifact provenance.

The applied/pending status and Apply button stay flush beneath the Settings
header while scrolling. Other families start compact: open **Profiles &
downloads** to manage weights or **Metrics & download sources** to compare
evidence. The selected family opens its profiles, and **Change quality** returns
to its quality controls. Live download progress stays outside collapsed details.
Hardware telemetry and extended selection information are available on demand.

## Installation and Apply contract

Model weights are not bundled in the app. An explicit install action fetches
only the selected manifest-pinned revision into staging, verifies every listed
file's byte size and SHA-256, and atomically activates the complete artifact on
disk. Installing does not select or load it. Normal dictation does not download
a missing model.

Family and performance controls edit a pending selection. **Apply model**
verifies the exact target before unloading the working runtime, preloads the
target with downloads disabled, and commits the new family/mode only after the
target reports ready. Applying must not retain both large models. A failed
apply keeps the previous committed selection authoritative and reports whether
its runtime was restored.

The UI must distinguish selected/pending, downloading, verifying, applying,
loaded/ready, and failed states. No state may imply that a downloaded or merely
selected model is active.

## Catalog contract

| Family | Engine | Supported profiles | Dictation modes | Languages |
| --- | --- | --- | --- | --- |
| Parakeet Unified EN 0.6B | FluidAudio / Core ML / ANE | High FP16, Medium INT8 | After-stop, Live | English |
| Canary-Qwen 2.5B | transcribe.cpp / Metal | High BF16, Medium Q8, Low Q4 | After-stop | English |
| Qwen3-ASR 0.6B | MLX Audio | High BF16, Medium 8-bit, Low 4-bit | After-stop | Catalog-declared capabilities |
| Qwen3-ASR 1.7B | MLX Audio | High BF16, Medium 8-bit, Low 4-bit | After-stop | Catalog-declared capabilities |

High always means original, unquantized precision. Parakeet has **no Low/Q4
profile** and LocalScribe never invents one. Auto chooses the highest installed
profile that fits the current unified-memory budget, only within the selected
family. Unsupported profiles, modes, or languages fail before a warm model is
unloaded or a download starts.

The Settings memory figures are conservative inference ranges, not file sizes
or benchmark measurements:

| Family | High | Medium | Low |
| --- | ---: | ---: | ---: |
| Parakeet Unified EN 0.6B | 0.8-1.3 GiB | 0.6-1.1 GiB | Not offered |
| Canary-Qwen 2.5B | 6.0-9.0 GiB | 4.0-7.0 GiB | 3.0-6.0 GiB |
| Qwen3-ASR 0.6B | 2.0-3.0 GiB | 1.4-2.3 GiB | 1.1-2.0 GiB |
| Qwen3-ASR 1.7B | 4.2-5.4 GiB | 2.6-3.6 GiB | 1.8-2.8 GiB |

Every mode reserves the greater of 2 GiB or 20% of total accelerator memory
above the tier's conservative maximum. Explicit profiles fail closed when they
do not fit. Auto samples unified-memory telemetry at each recording boundary,
does not count a warm model against itself, requires 1 GiB of additional free
memory before an upgrade, and pins its result for that dictation.

Parakeet Live uses FluidAudio's upstream streaming encoder. Upstream model-card
benchmarks are not LocalScribe end-to-end guarantees: microphone capture,
endpointing, application scheduling, and cross-app insertion are outside those
measurements.

## Trust and verification

The packaged catalog fixes engine, family, artifact identity, repository,
storage name, immutable revision, expected file sizes, and SHA-256 hashes.
There is no plugin API, arbitrary URL or repository field, custom loader,
custom manifest path, cloud inference, or silent fallback.

Two checks have different authority:

- the worker hashes every manifest file unconditionally before `load_model`;
- the main process hashes installed artifacts to report library, diagnostics,
  and Apply status, with identity-based digest memoization for responsiveness.

Directory shape, symlink rejection, exact entry set, and file sizes are always
rechecked. Nothing loads based only on the main process's memoized digest.

## Resident memory

The worker and active model remain warm between dictations. MLX temporary
buffers are cleared after success and failure while model weights stay loaded.
Quitting LocalScribe must unload the model and terminate the worker and native
helpers.

## Packaged manifest inventory

The macOS package contains exactly these model manifests:

```text
canary-qwen-2-5b-gguf-bf16.json
canary-qwen-2-5b-gguf-q8.json
canary-qwen-2-5b-gguf-q4.json
parakeet-unified-en-0-6b-coreml-fp16.json
parakeet-unified-en-0-6b-coreml-int8.json
qwen3-asr-0-6b-mlx-bf16.json
qwen3-asr-0-6b-mlx-8bit.json
qwen3-asr-0-6b-mlx-4bit.json
qwen3-asr-1-7b-mlx-bf16.json
qwen3-asr-1-7b-mlx-8bit.json
qwen3-asr-1-7b-mlx-4bit.json
```

The package gate removes every other manifest before signing. The source
manifests are the authority for revisions and per-file digests.

## License boundary

The Parakeet Unified Core ML artifact declares CC-BY-4.0 at its pinned
revision. FluidAudio declares Apache-2.0; that does not replace the model's
attribution obligations.

Whisper is removed from the catalog, worker, and packaged manifests. Historical
manifests remain recoverable in Git history, not in the app. Qwen3-ASR declares
Apache-2.0 and the curated Canary conversion declares CC-BY-4.0. Each exact
manifest remains authoritative; do not infer a license from a related runtime.

An upgrade preserves a retired saved selection and its cached model files.
The app reports that the selection is unavailable, blocks dictation, and lets
the user choose and Apply a supported replacement. It does not silently change
families or quantization. Old cached artifacts appear as unmanaged files; this
change does not delete them or existing transcript history. Legacy Whisper
family IDs remain recognized only to surface the unavailable selection and
require an explicit replacement Apply; no Whisper profile can load.

## Future additions

A new model or Turbo profile requires a complete macOS contract: fixed
artifacts, immutable revision and digest pins, verified installation, memory
policy, package inventory, license review, and real-device evidence. Research
and define that stack before implementation.
