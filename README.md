# LocalScribe

Private, local-first dictation for macOS and Windows. Your microphone audio is
transcribed on your computer—there is no transcription account, cloud API,
telemetry service, or listening network port.

## Download

### macOS validation builds

[**LocalScribe 0.1.0-dev.8 — macOS arm64**](https://github.com/bobjoemama/LocalScribe/releases/tag/v0.1.0-dev.8)

- **This repository is private.** The link above resolves only for a GitHub
  account that has access to it; everyone else gets a 404, not a download page.
  Without that access, build from source instead — see
  [Build from source](#build-from-source).
- Requires an Apple Silicon Mac and macOS 14 or newer.
- Download `LocalScribe-0.1.0-dev.8-arm64.dmg`. Do not download the
  source-code ZIP, and do not use `LocalScribe-darwin-arm64-0.1.0-dev.8.zip`
  expecting a Windows build — that ZIP is the same macOS app.
- Verify the download against the release's `SHA256SUMS.txt` asset before
  opening it:

  ```sh
  shasum -a 256 LocalScribe-0.1.0-dev.8-arm64.dmg
  # CHECKSUM-WILL-BE-FILLED-FROM-THE-VERIFIED-RELEASE-ARTIFACT
  ```

- The release description states whether that exact artifact is a private
  Apple Development validation build or a notarized public candidate.
- The model is downloaded separately inside LocalScribe after installation.

### Windows (not available yet)

There is no supported Windows download yet. The Windows backend can build a
verified portable ZIP on Windows 11 x64, but that artifact still needs the
remaining real-microphone, hotkey, paste, clean-user, and CUDA model-inference
acceptance pass before publication. There is currently no supported `.exe`
installer or automatic updater.

The `.zip` produced by the Mac build is also a **macOS** file; it is not a
Windows installer. Follow [Windows status and requirements](docs/WINDOWS.md)
for the exact validation boundary.

## Install on a Mac

1. Open the downloads page above and download the `.dmg` from the newest
   validation release.
2. Open the DMG.
3. Drag **LocalScribe** into **Applications**.
4. Open LocalScribe and allow **Microphone** access.
5. Allow **Accessibility** access when prompted if you want automatic insertion
   into text boxes. Common push-to-talk chords and toggle shortcuts work through
   narrow system APIs without that permission; uncommon PC-only hold keys may
   still require it.

If macOS refuses to open this validation build, do not disable system-wide
security protections. Use the local source-build instructions below or wait for
the notarized release.

## Set up dictation

1. Open **Settings → Model & Performance**.
2. Choose a model family and **Auto** unless you want to select a memory tier
   manually. Qwen3-ASR 0.6B is the smaller, lower-latency candidate; its
   real-device latency still needs comparative benchmarking.
3. Click the install action for the selected local model if its exact artifact
   is not already verified.
4. Review the pending family, tier, engine, and memory estimate, then click
   **Apply model**. Merely selecting or downloading a model does not change the
   active runtime.
5. Wait for LocalScribe to unload the previous model, verify and preload the
   target, and report it ready. The new family and tier are committed only
   after that load succeeds.
6. Open any text box and use the shortcut shown in the LocalScribe pill.

Model weights are not hidden inside the installer. LocalScribe downloads only
revision-pinned catalog files, checks their size and SHA-256 hash, and activates
them after verification. It never downloads a model just because dictation was
started.

## Performance modes

| Mode | macOS | Windows | Best for |
| --- | --- | --- | --- |
| Auto | Selects an MLX tier from available memory | Selects a CUDA tier from available VRAM | Most users |
| High | Selected family’s MLX FP16/BF16 model | CTranslate2 `float16` or Qwen F16 | Highest fidelity |
| Medium | Selected family’s MLX 8-bit model | CTranslate2 `int8_float16` or Qwen Q8_0 | Balanced memory and quality |
| Low | Selected family’s MLX 4-bit model | CTranslate2 `int8` or Qwen Q4_K | Lowest memory use |

Whisper large-v3 is the default family. Qwen3-ASR 0.6B, Qwen3-ASR 1.7B, and
the older Whisper large-v2 can be added from the local model library. Qwen3-ASR
0.6B is the smaller lower-latency candidate, not a claim of measured superiority.
On macOS, Whisper uses MLX Whisper and Qwen uses MLX Audio. On NVIDIA Windows,
Whisper uses faster-whisper/CTranslate2 and Qwen uses a pinned CrispASR
GGML/CUDA runtime.
Arbitrary model URLs, plugins, and custom model code are intentionally not
accepted. See the
[model catalog](docs/MODEL_CATALOG.md).

## What stays local

- Audio transcription and model inference
- Dictionary, snippets, notes, settings, and usage history
- SQLite data:
  - macOS: `~/Library/Application Support/LocalScribe/localscribe.db`
  - Windows: `%APPDATA%\LocalScribe\localscribe.db`
- Sensitive text protected with the operating system keystore

Raw audio is held in memory, written only to a permission-restricted temporary
WAV for inference, and deleted afterward.

Deleting a transcript — one entry, "Clear history", or an automatic retention
purge — overwrites its bytes inside the database file rather than only unlinking
the row. The database runs with SQLite's `secure_delete` pragma on, so freed
pages are zeroed as part of the delete instead of keeping their contents until
some later write happens to reuse them.

## System requirements

| Platform | Supported configuration |
| --- | --- |
| macOS | Apple Silicon, macOS 14+, Microphone permission; Accessibility is required for automatic insertion and uncommon PC-only hold keys |
| Windows | Windows 11 x64, supported NVIDIA GPU and driver, pinned CTranslate2 and CrispASR CUDA runtimes |

Intel Macs, Linux, Windows ARM, AMD/Intel GPUs, DirectML, and CPU-only Windows
inference are not packaged.

## Build from source

### Common verification

Install the exact Node, npm, and `uv` versions declared by
[`.nvmrc`](.nvmrc), [`packageManager`](package.json), and
[`.uv-version`](.uv-version), then run:

```sh
npm ci --strict-allow-scripts
npm run verify:local
```

### Build the Mac installer

Run on an Apple Silicon Mac with Xcode command-line tools:

```sh
npm run verify:local:macos
```

To include an exact installed-model load and repeated inference in the macOS
gate, supply both an existing model root and a 16 kHz mono PCM16 fixture:

```bash
npm run verify:local:macos -- \
  --smoke-model-root "$HOME/Library/Application Support/LocalScribe/models" \
  --smoke-audio /absolute/path/to/fixture.wav \
  --smoke-family qwen3-asr-0-6b --smoke-tier medium --smoke-repeat 2
```

The DMG, Mac ZIP, SBOMs, and checksum manifest are written under `out/`.
A normal local build uses an Apple Development or ad-hoc signature. Creating a
notarized public build requires the release credentials documented in
[the release procedure](docs/RELEASING.md).

### Build the Windows portable package

Run on Windows 11 x64 with PowerShell and Visual Studio C++ Build Tools:

```powershell
npm run verify:local:windows
```

On the NVIDIA system intended for use, also require the CUDA checks:

```powershell
npm run verify:local:windows -- -RequireCuda
```

An installed-model smoke is opt-in so the ordinary release gate does not
require multi-gigabyte weights:

```powershell
npm run verify:local:windows -- -RequireCuda `
  -CudaModelRoot "$env:APPDATA\LocalScribe\models" `
  -CudaFamily qwen3-asr-0-6b -CudaTier medium -CudaRepeat 2
```

The target gate produces one versioned portable ZIP, proves that it is an exact
byte-for-byte copy of the staged app, and writes versioned SBOMs plus a
versioned checksum manifest. Print the exact paths for the current checkout:

```powershell
node scripts/release-metadata.mjs --platform win32 --format json
```

Extract the ZIP before launching `LocalScribe.exe`; do not run the executable
from inside the archive. See the [Windows guide](docs/WINDOWS.md) before
publishing any Windows artifact.

## Documentation

| Document | Use it for |
| --- | --- |
| [Windows guide](docs/WINDOWS.md) | Windows, NVIDIA, CUDA, installation, and test status |
| [Model catalog](docs/MODEL_CATALOG.md) | Supported model families, modes, revisions, and licenses |
| [Packaging policy](docs/PACKAGING.md) | Files allowed inside each installer |
| [Release procedure](docs/RELEASING.md) | Signing, notarization, verification, and publication |
| [Audio protocol](docs/AUDIO_PROTOCOL.md) | Electron-to-worker audio contract |
| [Clean-room policy](docs/CLEAN_ROOM.md) | Product independence and provenance |
| [Delivery plan](docs/DELIVERY_PLAN.md) | Remaining implementation and validation work |
| [Independent review packet](docs/CLAUDE_FABLE_REVIEW_PACKET.md) | Evidence-gated external code review |
| [Opus 5 engineering packet](docs/OPUS_5_REVIEW_PACKET.md) | Whole-repository review, refactor, bug fixing, and GUI acceptance |

## Security and release status

- The Electron renderer is sandboxed with context isolation and no Node
  integration.
- IPC inputs are validated, and Electron fuses disable unnecessary runtime
  capabilities.
- Production JavaScript and locked Python dependency audits are part of local
  verification.
- The complete development-tool audit currently stops on
  [`GHSA-mh99-v99m-4gvg`](https://github.com/advisories/GHSA-mh99-v99m-4gvg),
  newly reported in Electron Forge's non-shipped packaging tree. The production
  graph and both Python graphs are clean, and the package inventory confirms
  that the affected build tools are absent from the app. Publication remains a
  validation prerelease until a compatible upstream fix is available.
- Generated runtimes, model weights, installers, signing credentials, and build
  outputs are not committed.
- No paid GitHub Actions or hosted CI/CD pipeline is used.

The macOS download above is a private validation build, not proof of notarized
public-release readiness. A Windows download will not be published until its
portable artifact passes native Windows and real NVIDIA/CUDA acceptance. A
Windows installer will remain unavailable until a supported installer,
signing, update, and uninstall design passes separate clean-machine tests.

## License

LocalScribe’s original source and assets are proprietary; see
[LICENSE](LICENSE). Third-party components retain their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
