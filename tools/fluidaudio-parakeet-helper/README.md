# LocalScribe FluidAudio Parakeet helper

This Swift executable is LocalScribe's native Apple Silicon runtime adapter for
Parakeet Unified EN 0.6B. It supports after-stop and incremental Live
recognition through FluidAudio, Core ML, and the Apple Neural Engine on macOS
14 or newer.

## Dependency and build contract

- Swift tools version: 6.0.
- Minimum platform: macOS 14.
- FluidAudio: exact release `0.15.5`; `Package.resolved` records revision
  `19600a485baa4998812e4654b70d2bab8f2c9949`.
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
length-prefixed, bounded protocol from standard input and writes bounded framed
responses to standard output. Audio is 16 kHz mono PCM16. The helper:

- accepts only the expected Parakeet model-directory name for the requested
  FP16 or INT8 precision;
- forces FluidAudio model loading offline after the Python worker has verified
  the manifest-owned file set, sizes, and SHA-256 digests;
- uses `.cpuAndNeuralEngine` for the encoder configuration;
- keeps at most one after-stop or Live manager loaded;
- closes the runtime when requested or when its input reaches EOF.

The path check inside this adapter is not the artifact-verification authority.
LocalScribe's Python worker owns exact manifest verification and the main
process owns lifecycle, process-tree termination, and package provenance.

Do not launch this helper directly as a supported user workflow, expose it on a
network port, add model downloads to it, or allow arbitrary executable model
plugins.
