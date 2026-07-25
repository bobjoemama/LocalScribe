# Windows x64 faster-whisper runtime

LocalScribe’s Windows inference path uses the default
`Systran/faster-whisper-large-v3` family, with
`Systran/faster-whisper-large-v2` available as a curated user-addable family,
through faster-whisper and CTranslate2 CUDA. It is deliberately separate from
the macOS MLX worker while preserving the same bounded NDJSON protocol,
Electron UI, persistence model, and explicit model-installation flow.

## Supported boundary

The intended first tier is:

- Windows 11 x64
- NVIDIA GPU supported by the pinned CTranslate2 CUDA 12 / cuDNN 9 runtime
- a current NVIDIA driver
- enough free VRAM for the selected compute profile
- at least 6 GiB free disk before beginning a model installation

CPU-only, AMD, Intel, DirectML, Windows arm64, and Linux are not advertised.
CTranslate2 makes the final compute-type capability check on the actual GPU and
fails before loading an unsupported profile.

For each Windows family, the three user tiers share one immutable model
artifact:

| Tier | CTranslate2 compute type | Estimated accelerator memory |
| --- | --- | --- |
| High | `float16` | 4.5–5.5 GiB |
| Medium | `int8_float16` | 2.9–3.5 GiB |
| Low | `int8` | 2.6–3.3 GiB |

Those ranges are conservative estimates, not physical benchmark results. Auto
uses current NVML total/free VRAM plus fixed headroom and hysteresis policy; it
does not download a different Windows model. The four available choices are
Auto, High, Medium, and Low; Auto is policy rather than a fourth artifact.

## Pinned worker and model

The worker project remains under `worker/windows_transformers/` for source-path
compatibility, but its backend is faster-whisper—not Hugging Face Transformers.
The committed Windows `pyproject.toml` and `uv.lock` are the authoritative
runtime pins. `uv lock --check --project worker/windows_transformers` and the
SBOM gate fail if the declared and locked graph drift; do not copy the current
dependency versions into a packaging script.

The immutable model authorities are
[`faster-whisper-large-v3.json`](../resources/model-manifest/faster-whisper-large-v3.json)
and [`faster-whisper-large-v2.json`](../resources/model-manifest/faster-whisper-large-v2.json).
Large-v3 is the default; large-v2 can be added through the curated library.
The corresponding Systran manifest metadata says MIT for both Windows
artifacts. The manifests themselves are the authority for model ID, revision,
license, per-file byte counts, and SHA-256 digests.

Every listed file has an exact byte count and SHA-256 digest. The worker stages
downloads, rejects symlinks and unexpected file types, verifies every required
file, and atomically activates only the complete directory. Runtime loading is
`local_files_only=True`. Weights are never bundled in the app package and only an
explicit install action may download an approved, revision-pinned artifact.

## Narrow media and process boundary

The worker accepts only mono 16 kHz signed PCM16 WAV under the main process’s
permitted temporary root. It validates the WAV itself and passes a bounded
NumPy PCM array to faster-whisper; PyAV does not receive an arbitrary
renderer-controlled path or container.

Supported protocol messages are:

- `hello`
- `device_info`
- `install_model`
- `load_model`
- `health`
- `transcribe`
- `shutdown`

Each `load_model` request must provide a mutually consistent allowlisted
`tier`, `modelId`, and `computeType`. Downloads require an explicit
`allowDownload: true`; normal dictation sends false. stdout is protocol-only,
stderr is diagnostic, main-to-worker request lines are bounded to 16 KiB, and
worker-to-main response lines are bounded to 1 MiB so the worker's permitted
100,000-character transcription remains representable even with worst-case
JSON escaping. There is no local HTTP
server. The family/tier catalog is packaged: no plugin, arbitrary URL,
arbitrary code, or custom model loader is accepted.

## Build on Windows

Install the exact Node, npm, and `uv` versions declared by `.nvmrc`,
`package.json`’s `packageManager`, and `.uv-version`, plus Visual Studio Build
Tools with the Desktop development with C++ workload. The exact
`@electron/rebuild` version is declared and locked in `package.json` and
`package-lock.json`. Then run:

```powershell
npm ci --strict-allow-scripts
npm run verify:local:windows
```

`verify:local` first performs a Windows x64 npm clean-install simulation and a
locked `uv sync --dry-run --no-build` against
`x86_64-pc-windows-msvc`. This catches missing platform-specific lock records
and missing binary wheels before target packaging. It also lints and runs the
dependency-light Windows worker tests. The target-machine wrapper additionally
requires the exact Node version pinned in `.nvmrc`; npm is checked against the
exact `packageManager` pin.

The runtime builder:

- resolves and verifies the exact `uv` version from `.uv-version` before mutation;
- rejects a linked/reparse runtime root, builds in a private sibling staging
  directory, and promotes only after import and reparse-point checks pass;
- restores the prior runtime if atomic promotion fails;
- installs the pinned CPython 3.12.13 runtime;
- performs `uv sync --locked --no-dev --no-editable --link-mode copy` and
  force-rebuilds LocalScribe's first-party worker so a same-version cached wheel
  cannot enter a newer package;
- imports CTranslate2, faster-whisper, and the worker from the generated venv;
- removes wheel tests, caches, bytecode, activation/build scripts, and
  developer console entrypoints.

The native build compiles `active-target.cpp` for x64 with `/analyze`, `/sdl`,
`/GS`, Control Flow Guard, high-entropy ASLR, DEP, CET compatibility,
System32-only dependent DLL search, and warnings-as-errors, then runs
deterministic self-test and clipboard smoke commands.

Run the worker’s dependency-light mocked tests with the bundled interpreter:

```powershell
& resources\python-runtime-windows\venv\Scripts\python.exe `
  -m unittest discover -s worker\windows_transformers\tests -v
```

Create the supported portable validation package:

```powershell
npm run verify:local:windows
```

This produces one versioned portable ZIP, two versioned Windows CycloneDX
SBOMs, and a versioned checksum manifest. Resolve their exact paths from the
same metadata used by Forge:

```powershell
node scripts/release-metadata.mjs --platform win32 --format json
node scripts/verify-release-assets.mjs --platform win32
```

Forge extracts the ZIP into a private temporary directory, rejects
links/reparse entries, and hashes every file to prove that the archive is an
exact copy of the staged app. Forge refuses to package when the runtime,
helper, model manifest, worker entrypoints, or Windows tray icon are missing.
The complete gate also starts the packaged app with an isolated profile,
re-runs the worker tests with the bundled interpreter, checks inference imports,
and validates the expected Authenticode state.

On an NVIDIA-equipped validation machine, require CUDA discovery and every
advertised compute type:

```powershell
npm run verify:local:windows -- -RequireCuda
```

This verifies the pinned CTranslate2/faster-whisper/NumPy/NVML versions,
CTranslate2 CUDA device discovery, current NVML memory telemetry, and support
for `float16`, `int8_float16`, and `int8`. It does not by itself load the
3.09 GB model or prove transcription accuracy.

If the pinned model is already installed, add its parent model directory to
perform a checksum-verified medium-tier CUDA load and a one-second local
inference without any implicit download:

```powershell
npm run verify:local:windows -- -RequireCuda `
  -CudaModelRoot "$env:APPDATA\LocalScribe\models"
```

## Installer, signing, login, and updates

`npm run make:windows` intentionally emits an unsigned portable validation ZIP,
not an installer. Extract it to an ordinary local directory and run
`LocalScribe.exe` from there. LocalScribe registers that exact portable
executable for optional hidden login startup; moving or deleting the extracted
directory invalidates that registration until the app is launched again.

Squirrel is disabled by default. Its 32-bit `WriteZipToSetup.exe` helper was
reproduced silently failing once LocalScribe's compressed CUDA/Python package
passed roughly 950–970 MB: Forge returned success, but the 227 KB Setup.exe
still contained Squirrel's dummy payload. The repository now contains a
fail-closed PE-resource/ZIP verifier for regression diagnosis, and
`LOCALSCRIBE_BUILD_LEGACY_SQUIRREL=1` may be used only by a developer to prove
that a future smaller or upstream-fixed package passes it. That opt-in output
is unsupported and must not be published.

`LOCALSCRIBE_RELEASE=1` on Windows fails before packaging. Public Windows
publication stays disabled until there is a passwordless managed signing path,
a supported installer, clean-machine install/uninstall evidence, and a tested
update design. No update feed or automatic updater is configured. Portable
users update manually by quitting LocalScribe, extracting the new verified
package to a new directory, launching it once so login startup is repaired,
and removing the old directory only after their local data is confirmed. User
data and models live outside the portable program directory.

## Evidence boundary

Local verification on a Windows 11 x64 machine can establish:

- lock and JavaScript dependency integrity;
- TypeScript and Vitest behavior;
- mocked worker protocol behavior;
- full Windows runtime assembly and import;
- MSVC x64 helper compile/self-test;
- native Node rebuild and verified portable ZIP creation;
- whole-package platform isolation;
- packaged startup, bundled inference imports, SBOMs, and artifact checksums;
- CUDA device/compute-profile discovery when `-RequireCuda` is used;
- checksum-verified model load and inference when `-CudaModelRoot` is supplied;
- the current Authenticode state of packaged PE files.

A build performed without a physical NVIDIA validation pass cannot establish:

- real CUDA model load or inference;
- accuracy, latency, or peak VRAM for any tier;
- microphone prompt/denial/recovery behavior;
- real global hotkeys or target-guarded paste across desktop apps;
- clean-user portable extraction/manual-update behavior;
- installer/update/uninstall behavior (no supported installer exists);
- SmartScreen reputation.

A Windows portable build is user-ready only after the exact candidate passes
real-microphone, real-CUDA, hotkey, paste, tray, login, and manual-update tests
on the claimed minimum GPU tier and at least one current RTX generation. A
Windows installer is a separate future deliverable and requires clean
install/update/uninstall plus SmartScreen testing.
