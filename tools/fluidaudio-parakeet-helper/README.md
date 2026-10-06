# LocalScribe native speech helper

This Swift executable is LocalScribe's native Apple Silicon runtime adapter for
Parakeet Unified EN 0.6B, Phonon-2 dense LUT6 on CPU/Neural Engine, Phonon-2
dense LUT3 on CPU/GPU, and Moonshine Small Streaming on CPU. All support
after-stop and incremental Live recognition. Parakeet and Moonshine require
macOS 14 or newer; Phonon-2 requires macOS 15 or newer. The existing executable
name is retained for packaging compatibility.

## Dependency and build contract

- Swift tools version: 6.0; dependencies require Swift 6.1 or newer.
- Minimum platform: macOS 14.
- FluidAudio: exact release `0.17.5`; `Package.resolved` records revision
  `0b1f46289fe27d95b5e66ad8be46e64f5ee02ae7`.
- Moonshine Swift: exact release `0.1.5`, revision
  `45a14f9edf1f2a6913d3aff38c1fd4e72d5b7daa`; its checksum-pinned native binary
  links statically. The CPU execution provider is explicitly selected.
- Output architecture: arm64 only in the LocalScribe package gate.
- Supported precisions: Core ML FP16 and INT8. There is no Parakeet Low/Q4
  profile.

The supported build entry point is the repository-level command:

```sh
npm run worker:bundle
```

That command checks the host platform and pinned `uv` version, builds the
locked Python worker runtime, invokes Swift Package Manager, verifies the
helper architecture, and stages the resulting executable for packaging. The
release package copies and signs the staged executable; it does not ship this
Swift source tree or the Swift build checkout.

Xcode and the Swift compiler are host-toolchain inputs and are not fully pinned
by this repository. The FluidAudio dependency itself is exact and resolved.

## Runtime boundary

The helper is a LocalScribe child process, not a server. It reads a
length-prefixed, bounded version-2 protocol from standard input and writes bounded framed
responses to standard output. Audio is 16 kHz mono PCM16. The helper:

- accepts only the exact curated model-directory name for the requested profile;
- forces FluidAudio model loading offline after the Python worker has verified
  the manifest-owned file set, sizes, and SHA-256 digests;
- selects `.cpuAndNeuralEngine` for Parakeet and Phonon LUT6 encoders,
  `.cpuAndGPU` for Phonon LUT3, and ONNX CPU for Moonshine;
- loads Phonon component files directly from their verified original paths,
  without renaming or modifying the model artifact;
- uses bounded Phonon live windows with per-window acknowledgement and Moonshine
  explicit updates so inference failures surface instead of becoming silence;
- keeps at most one after-stop or Live manager loaded;
- closes the runtime when requested or when its input reaches EOF.

The path check inside this adapter is not the artifact-verification authority.
LocalScribe's Python worker owns exact manifest verification and the main
process owns lifecycle, process-tree termination, and package provenance.

Do not launch this helper directly as a supported user workflow, expose it on a
network port, add model downloads to it, or allow arbitrary executable model
plugins.
