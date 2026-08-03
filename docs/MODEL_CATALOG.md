# Curated model catalog

LocalScribe ships a fixed, platform-specific catalog. Whisper large-v3 is the
default family. Qwen3-ASR 0.6B, Qwen3-ASR 1.7B, and the older Whisper large-v2
are curated families that a user may add to the local library; none is selected
from an arbitrary repository or URL. Qwen3-ASR 0.6B is included as the smaller
lower-latency candidate, but comparative latency and quality remain a
real-device benchmark question rather than a release claim.

Model weights are not in the app installer. An explicit install action fetches
only the selected manifest-pinned revision into a staging directory, verifies
every listed file's byte size and SHA-256, and activates the complete artifact
atomically on disk. Installing does not select or load that artifact. Normal
dictation does not download a missing model.

## Catalog contract

| Platform | Family | Fixed engine | High / Medium / Low |
| --- | --- | --- | --- |
| macOS arm64 | Whisper large-v3 and large-v2 | MLX Whisper | distinct FP16 / 8-bit / 4-bit artifacts |
| macOS arm64 | Qwen3-ASR 0.6B | MLX Audio | distinct BF16 / 8-bit / 4-bit artifacts |
| macOS arm64 | Qwen3-ASR 1.7B | MLX Audio | distinct BF16 / 8-bit / 4-bit artifacts |
| Windows x64 NVIDIA | Whisper large-v3 and large-v2 | faster-whisper / CTranslate2 CUDA | one artifact loaded as `float16` / `int8_float16` / `int8` |
| Windows x64 NVIDIA | Qwen3-ASR 0.6B | CrispASR / GGML CUDA | distinct F16 / Q8_0 / Q4_K GGUF artifacts |
| Windows x64 NVIDIA | Qwen3-ASR 1.7B | CrispASR / GGML CUDA | distinct F16 / Q8_0 / Q4_K GGUF artifacts |

The model-memory figures shown in Settings are conservative inference ranges,
not just file sizes:

| Platform and family | High | Medium | Low |
| --- | ---: | ---: | ---: |
| Mac Whisper large-v3 or large-v2 | 4.0–5.5 GiB | 2.5–3.5 GiB | 1.8–2.7 GiB |
| Mac Qwen3-ASR 0.6B | 2.0–3.0 GiB | 1.4–2.3 GiB | 1.1–2.0 GiB |
| Mac Qwen3-ASR 1.7B | 4.2–5.4 GiB | 2.6–3.6 GiB | 1.8–2.8 GiB |
| Windows Whisper large-v3 or large-v2 | 4.5–5.5 GiB VRAM | 2.9–3.5 GiB VRAM | 2.6–3.3 GiB VRAM |
| Windows Qwen3-ASR 0.6B | 2.5–3.5 GiB VRAM | 1.6–2.6 GiB VRAM | 1.2–2.2 GiB VRAM |
| Windows Qwen3-ASR 1.7B | 4.8–5.8 GiB VRAM | 2.6–3.6 GiB VRAM | 1.8–2.8 GiB VRAM |

These are catalog safety estimates, not measurements. Mac Qwen3-ASR 1.7B 8-bit
inference has been exercised on an M4 Max; that evidence does not establish
Qwen3-ASR 0.6B latency or memory. Every Windows Qwen tier remains subject to the
physical Windows/NVIDIA release gate.

The only performance choices are Auto, High, Medium, and Low. Auto resolves to
one of the three concrete profiles from local accelerator-memory policy; it is
not a model, manifest, or fourth physical artifact.

Family and performance controls edit one pending selection. They do not unload,
load, download, or persist a model by themselves. **Apply model** is the commit
boundary: it verifies the exact target artifact, unloads the previous runtime,
preloads the target with downloading disabled, and commits the new family/mode
only after the target reports ready. The switch must not intentionally retain
both models in memory. If applying fails, the prior committed selection remains
authoritative and LocalScribe reports whether restoring its runtime succeeded.

Every mode reserves the greater of 2 GiB or 20% of total accelerator memory
above the tier's conservative maximum estimate. Explicit High/Medium/Low fail
closed when their exact tier does not fit and never substitute another tier.
Auto samples live accelerator telemetry at each recording boundary. When a
model is warm, selection policy adds that tier's conservative minimum
allocation back to the reported free-memory value (capped at physical memory)
so the model does not count against itself. Auto selects the highest fitting
tier, requires 1 GiB of additional free memory before an upgrade, downgrades
when necessary, and pins the result through that dictation.

The packaged catalog is the sole selection authority. It fixes the platform,
engine, family, artifact identity, repository ID, storage name, immutable
revision, expected file sizes, and SHA-256 hashes. There is no plugin API,
arbitrary URL or repository input, arbitrary code, custom loader, or custom
manifest path.

Immutable repository, revision, artifact, storage, and file identity are read
from the packaged manifests instead of being copied into TypeScript and both
Python workers. This is safe in a release because the loose-resource integrity
root covers the exact platform manifest files before startup. The remaining
allowlist is intentional and smaller: the app package fixes manifest
filenames, family IDs, platform engine, three compute profiles, and memory
policy. “Add model” therefore means add/activate a model already curated into
this signed build. It does not mean paste a Hugging Face repository or URL.
Supporting user-supplied manifests would require a separate signed-catalog
trust design and is deliberately not implemented.

## Packaged manifest inventory

Mac packages contain exactly these twelve MLX manifests:

```text
whisper-large-v3-mlx.json
whisper-large-v3-mlx-8bit.json
whisper-large-v3-mlx-4bit.json
qwen3-asr-1-7b-mlx-bf16.json
qwen3-asr-1-7b-mlx-8bit.json
qwen3-asr-1-7b-mlx-4bit.json
qwen3-asr-0-6b-mlx-bf16.json
qwen3-asr-0-6b-mlx-8bit.json
qwen3-asr-0-6b-mlx-4bit.json
whisper-large-v2-mlx.json
whisper-large-v2-mlx-8bit.json
whisper-large-v2-mlx-4bit.json
```

Windows packages contain exactly these eight CUDA manifests:

```text
faster-whisper-large-v3.json
qwen3-asr-1-7b-crisp-f16.json
qwen3-asr-1-7b-crisp-q8-0.json
qwen3-asr-1-7b-crisp-q4-k.json
qwen3-asr-0-6b-crisp-f16.json
qwen3-asr-0-6b-crisp-q8-0.json
qwen3-asr-0-6b-crisp-q4-k.json
faster-whisper-large-v2.json
```

The package gate removes all other manifests, including the other platform's
files, before signing. The source manifests provide the exact revision and
per-file digest records; do not substitute a moving branch, a repository name,
or a new file list for those pins.

On multi-GPU Windows systems the worker enumerates current NVML devices, chooses
the valid device with the most free VRAM (then total VRAM, then the lower
ordinal for a deterministic tie), reports that physical ordinal, and exposes
only that adapter inside the isolated worker. CTranslate2 and CrispASR then see
the selected physical adapter as logical CUDA device 0. A fresh worker repeats
selection; neither engine silently switches to a different physical GPU.

## License boundary

The macOS large-v3 FP16 manifest and the Windows Systran faster-whisper
large-v3 and large-v2 manifests declare MIT. The pinned macOS large-v3 8-bit
and 4-bit revisions, and all three pinned macOS
`mlx-community/whisper-large-v2-mlx` revisions, carry `Undeclared` license
metadata because no license declaration was found at those exact revisions.
That does not establish an MIT grant: those artifacts require a separate
license review before they are represented as distribution-ready.

The pinned Qwen3-ASR 0.6B and 1.7B model repositories declare Apache-2.0. The Windows native
CrispASR runtime is MIT-licensed; its exact release archive and retained DLLs
are SHA-256 pinned, and its license and third-party notices are included in the
Windows package.

## Turbo

Turbo is not enabled. Adding it requires a complete, validated three-tier Mac
contract—not merely a new model ID—including fixed MLX FP16/8-bit/4-bit
artifacts, immutable manifest pins, verified installation behavior, resource
evidence, package inventory coverage, and real-device validation for every
tier.
