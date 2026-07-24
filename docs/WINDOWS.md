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
Important direct pins in its committed lock include:

- Python 3.12.13
- faster-whisper 1.2.1
- CTranslate2 4.8.1
- PyAV 18.0.0
- NumPy 2.5.1
- CUDA 12.9 cuBLAS/NVRTC packages
- cuDNN 9.25
- pynvml 13.610.43

The immutable model authorities are
[`faster-whisper-large-v3.json`](../resources/model-manifest/faster-whisper-large-v3.json)
and [`faster-whisper-large-v2.json`](../resources/model-manifest/faster-whisper-large-v2.json).
Large-v3 is the default; large-v2 can be added through the curated library.
The corresponding Systran manifest metadata says MIT for both Windows
artifacts. For example, the default v3 authority is:

```text
model:    Systran/faster-whisper-large-v3
revision: edaa852ec7e145841d8ffdb056a99866b5f0a478
bytes:    3,090,835,702
license:  MIT
```

Every listed file has an exact byte count and SHA-256 digest. The worker stages
downloads, rejects symlinks and unexpected file types, verifies every required
file, and atomically activates only the complete directory. Runtime loading is
`local_files_only=True`. Weights are never bundled in the installer and only an
explicit install action may download an approved, revision-pinned artifact.

## Narrow media and process boundary

The worker accepts only mono 16 kHz signed PCM16 WAV under the main process’s
permitted temporary root. It validates the WAV itself and passes a bounded
NumPy PCM array to faster-whisper; PyAV does not receive an arbitrary
renderer-controlled path or container.

Supported protocol messages are:

- `hello`
- `device_info`
- `load_model`
- `health`
- `transcribe`
- `shutdown`

Each `load_model` request must provide a mutually consistent allowlisted
`tier`, `modelId`, and `computeType`. Downloads require an explicit
`allowDownload: true`; normal dictation sends false. stdout is protocol-only,
stderr is diagnostic, main-to-worker request lines are bounded to 16 KiB, and
worker-to-main response lines are bounded to 64 KiB. There is no local HTTP
server. The family/tier catalog is packaged: no plugin, arbitrary URL,
arbitrary code, or custom model loader is accepted.

## Build on Windows

Install Node 24.18.0, npm 11.16.0, `uv` 0.11.11, and Visual Studio 2026
Build Tools with the Desktop development with C++ workload. LocalScribe pins
`@electron/rebuild` 4.2.0, which uses a node-gyp release that recognizes
Visual Studio 2026. Then run:

```powershell
npm ci --strict-allow-scripts
npm run worker:check-locks
npm run worker:bundle:windows
npm run native:build:windows
```

The runtime builder:

- installs the pinned CPython 3.12.13 runtime;
- performs `uv sync --locked --no-dev --no-editable --link-mode copy` and
  force-rebuilds LocalScribe's first-party worker so a same-version cached wheel
  cannot enter a newer package;
- imports CTranslate2, faster-whisper, and the worker from the generated venv;
- removes wheel tests, caches, bytecode, activation/build scripts, and
  developer console entrypoints.

The native build compiles `active-target.cpp` for x64 with `/sdl`, `/GS`,
Control Flow Guard, ASLR, DEP, CET compatibility, and strict warnings, then
runs deterministic self-test and clipboard smoke commands.

Run the worker’s dependency-light mocked tests with the bundled interpreter:

```powershell
& resources\python-runtime-windows\venv\Scripts\python.exe `
  -m unittest discover -s worker\windows_transformers\tests -v
```

Create a complete Squirrel validation installer:

```powershell
npm run make:windows
```

This produces `LocalScribe-Setup.exe`, `RELEASES`, and a `.nupkg` under
`out\make\`. Forge refuses to package when the runtime, helper, model manifest,
worker entrypoints, or Windows tray icon are missing.

## Signing

An ordinary `npm run make:windows` is an unsigned validation build. Public mode
is enabled only with `LOCALSCRIBE_RELEASE=1` and requires either:

- `WINDOWS_SIGN_WITH_PARAMS`, for a managed/EV signing flow; or
- `WINDOWS_CERTIFICATE_FILE` plus `WINDOWS_CERTIFICATE_PASSWORD`.

`WINDOWS_TIMESTAMP_SERVER` is also required and must use HTTPS. Release mode
signs the packaged app/helper and Squirrel artifacts, then checks
`Get-AuthenticodeSignature` for the app, helper, and Setup.exe. Missing
credentials fail before packaging.

## Evidence boundary

Local verification on a Windows 11 x64 machine can establish:

- lock and JavaScript dependency integrity;
- TypeScript and Vitest behavior;
- mocked worker protocol behavior;
- full Windows runtime assembly and import;
- MSVC x64 helper compile/self-test;
- native Node rebuild and Squirrel artifact creation;
- whole-package platform isolation;
- Authenticode validity when local release credentials are configured.

A build performed without a physical NVIDIA validation pass cannot establish:

- real CUDA model load or inference;
- accuracy, latency, or peak VRAM for any tier;
- microphone prompt/denial/recovery behavior;
- real global hotkeys or target-guarded paste across desktop apps;
- clean-user install/update/uninstall behavior;
- SmartScreen reputation.

A Windows build is user-ready only after the signed installed app passes
real-microphone, real-CUDA, hotkey, paste, tray, login, update, and uninstall
tests on the claimed minimum GPU tier and at least one current RTX generation.
