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

The packaged catalog is the sole selection authority. It fixes the platform,
engine, family, artifact identity, repository ID, storage name, immutable
revision, expected file sizes, and SHA-256 hashes. There is no plugin API,
arbitrary URL or repository input, arbitrary code, custom loader, or custom
manifest path.

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

## License boundary

The large-v3 MLX manifests declare MIT. The Windows Systran faster-whisper
large-v3 and large-v2 manifests declare MIT. The macOS
`mlx-community/whisper-large-v2-mlx` manifests carry `Undeclared` license
metadata. That does not establish an MIT grant: distribution of the macOS v2
artifact requires a separate license review before it is represented as
distribution-ready.

## Turbo

Turbo is not enabled. Adding it requires a complete, validated three-tier Mac
contract—not merely a new model ID—including fixed MLX FP16/8-bit/4-bit
artifacts, immutable manifest pins, verified installation behavior, resource
evidence, package inventory coverage, and real-device validation for every
tier.
