# Curated model catalog

LocalScribe ships a fixed, platform-specific catalog. Whisper large-v3 is the
default family. Whisper large-v2 is a curated family that a user may add to the
local library; it is not selected from an arbitrary repository or URL.

Model weights are not in the app installer. An explicit install action fetches
only the selected manifest-pinned revision into a staging directory, verifies
every listed file's byte size and SHA-256, and activates the complete artifact
atomically. Normal dictation does not download a missing model.

## Catalog contract

| Platform | Fixed engine | Family and profile contract |
| --- | --- | --- |
| macOS arm64 | MLX Whisper | large-v3 and large-v2 each have distinct FP16 (High), 8-bit (Medium), and 4-bit (Low) artifacts. |
| Windows x64 NVIDIA | faster-whisper / CTranslate2 CUDA | large-v3 and large-v2 each have one shared artifact, used with `float16` (High), `int8_float16` (Medium), and `int8` (Low). |

The only performance choices are Auto, High, Medium, and Low. Auto resolves to
one of the three concrete profiles from local accelerator-memory policy; it is
not a model, manifest, or fourth physical artifact.

Every mode reserves the greater of 2 GiB or 20% of total accelerator memory
above the tier's conservative maximum estimate. Explicit High/Medium/Low fail
closed when their exact tier does not fit and never substitute another tier.
Auto probes an unloaded accelerator at each recording boundary, selects the
highest fitting tier, requires 1 GiB of additional free memory before an
upgrade, downgrades immediately when necessary, and pins the result through
that dictation.

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

Mac packages contain exactly these six MLX manifests:

```text
whisper-large-v3-mlx.json
whisper-large-v3-mlx-8bit.json
whisper-large-v3-mlx-4bit.json
whisper-large-v2-mlx.json
whisper-large-v2-mlx-8bit.json
whisper-large-v2-mlx-4bit.json
```

Windows packages contain exactly these two faster-whisper manifests:

```text
faster-whisper-large-v3.json
faster-whisper-large-v2.json
```

The package gate removes all other manifests, including the other platform's
files, before signing. The source manifests provide the exact revision and
per-file digest records; do not substitute a moving branch, a repository name,
or a new file list for those pins.

On multi-GPU Windows systems the worker enumerates current NVML devices, chooses
the valid device with the most free VRAM (then total VRAM, then the lower
ordinal for a deterministic tie), reports that ordinal, and reuses it for the
CTranslate2 capability probe and model load. A fresh worker repeats selection;
it never silently falls back to CUDA device 0.

## License boundary

The macOS large-v3 FP16 manifest and the Windows Systran faster-whisper
large-v3 and large-v2 manifests declare MIT. The pinned macOS large-v3 8-bit
and 4-bit revisions, and all three pinned macOS
`mlx-community/whisper-large-v2-mlx` revisions, carry `Undeclared` license
metadata because no license declaration was found at those exact revisions.
That does not establish an MIT grant: those artifacts require a separate
license review before they are represented as distribution-ready.

## Turbo

Turbo is not enabled. Adding it requires a complete, validated three-tier Mac
contract—not merely a new model ID—including fixed MLX FP16/8-bit/4-bit
artifacts, immutable manifest pins, verified installation behavior, resource
evidence, package inventory coverage, and real-device validation for every
tier.
