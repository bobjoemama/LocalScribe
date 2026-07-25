# LocalScribe

Private, local-first dictation for macOS and Windows. Your microphone audio is
transcribed on your computer—there is no transcription account, cloud API,
telemetry service, or listening network port.

## Download

### macOS validation builds

[**Open LocalScribe downloads**](https://github.com/bobjoemama/LocalScribe/releases)

- Requires an Apple Silicon Mac and macOS 14 or newer.
- Choose the newest prerelease and download its `.dmg` asset. Do not download
  the source-code ZIP when you want to install the app.
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
5. Allow **Accessibility** access when prompted if you want global shortcuts
   and automatic insertion into text boxes.

If macOS refuses to open this validation build, do not disable system-wide
security protections. Use the local source-build instructions below or wait for
the notarized release.

## Set up dictation

1. Open **Settings → Model & Performance**.
2. Choose **Auto** unless you want to select a memory tier manually.
3. Click the install action for the selected local model.
4. Wait for LocalScribe to verify and activate the model.
5. Open any text box and use the shortcut shown in the LocalScribe pill.

Model weights are not hidden inside the installer. LocalScribe downloads only
revision-pinned catalog files, checks their size and SHA-256 hash, and activates
them after verification. It never downloads a model just because dictation was
started.

## Performance modes

| Mode | macOS | Windows | Best for |
| --- | --- | --- | --- |
| Auto | Selects an MLX tier from available memory | Selects a CUDA tier from available VRAM | Most users |
| High | Whisper large-v3 FP16 | CTranslate2 `float16` | Highest fidelity |
| Medium | Whisper large-v3 8-bit | CTranslate2 `int8_float16` | Balanced memory and quality |
| Low | Whisper large-v3 4-bit | CTranslate2 `int8` | Lowest memory use |

Whisper large-v3 is the default family. Curated large-v2 variants can be added
from the local model library. Arbitrary model URLs, plugins, and custom model
code are intentionally not accepted. See the
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

## System requirements

| Platform | Supported configuration |
| --- | --- |
| macOS | Apple Silicon, macOS 14+, Microphone permission, Accessibility permission for global shortcuts and insertion |
| Windows | Windows 11 x64, supported NVIDIA GPU and driver, CUDA-capable pinned CTranslate2 runtime |

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
