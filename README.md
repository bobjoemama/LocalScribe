# LocalScribe

LocalScribe is a private, local-first desktop dictation app for Apple Silicon
Macs and Windows 11 NVIDIA PCs. Audio is transcribed by a resident local Python
worker over stdin/stdout; there is no transcription web service, account,
telemetry, or listening TCP port.

The macOS and Windows apps share the Electron UI, encrypted SQLite data model,
audio protocol, shortcuts, text cleanup, and target-guarded insertion. Their
inference engines are deliberately platform-specific:

| Platform | Backend | Physical model artifacts |
| --- | --- | --- |
| macOS arm64 | MLX Whisper | Whisper large-v3 FP16, 8-bit, and 4-bit manifests |
| Windows x64 | faster-whisper / CTranslate2 CUDA | One verified Whisper large-v3 artifact with trusted FP16, INT8-FP16, and INT8 compute profiles |

Model weights are not embedded in the installer. An explicit install action
downloads the selected, revision-pinned files to a staging directory and
activates them only after full size and SHA-256 verification. Dictation never
turns a missing model into an implicit download.

## Performance modes

LocalScribe exposes exactly four user modes:

- **Auto** resolves to one of the concrete tiers from stable local hardware
  capabilities. Auto is policy, not a fourth model or manifest.
- **High** prioritizes fidelity: MLX FP16 on Mac and CTranslate2 `float16` on
  Windows.
- **Medium** balances memory and fidelity: MLX 8-bit on Mac and
  `int8_float16` on Windows.
- **Low** minimizes accelerator memory: MLX 4-bit on Mac and `int8` on
  Windows.

The main process resolves the requested mode only through its packaged
allowlist. The worker independently rejects unknown model IDs, revisions,
storage directories, and compute profiles. The Settings UI reports both the
requested and effective tier.

## Install a finished build

### macOS

Production distribution requires an Apple **Developer ID Application**
signature, hardened runtime, notarization, and stapling.

1. Open the signed `LocalScribe-<version>-arm64.dmg`.
2. Drag LocalScribe to Applications.
3. Launch it and grant Microphone permission.
4. Grant Accessibility permission only if automatic paste and global
   hold-to-talk are desired.
5. Open **Model & Performance**, choose a mode, and explicitly install its
   local model.

Apple Development and ad-hoc builds are local validation artifacts. They are
not substitutes for notarized distribution and should not be shared with end
users.

### Windows

Production distribution requires an Authenticode-signed and timestamped
Squirrel installer.

1. Run `LocalScribe-Setup.exe`.
2. Allow microphone access when Windows asks.
3. Open **Model & Performance**, choose a mode, and explicitly install the
   local model.

An unsigned validation installer may trigger SmartScreen and proves neither
publisher identity nor release readiness. Do not distribute it as a production
build.

## Runtime requirements

### macOS

- Apple Silicon (`arm64`)
- macOS 14 or newer
- enough free disk for the selected Whisper large-v3 artifact and its staging
  copy during installation
- Microphone permission; Accessibility permission for global hold/paste

Intel Macs and Linux are not packaged.

### Windows

- Windows 11 x64
- NVIDIA GPU supported by the pinned CTranslate2/CUDA runtime
- current NVIDIA driver
- sufficient free VRAM and disk for the selected compute profile and the
  verified large-v3 install transaction

CPU-only, AMD, Intel, DirectML, and Windows arm64 are not advertised. See
[docs/WINDOWS.md](docs/WINDOWS.md) for the exact evidence boundary.

## Build from source

Common requirements:

- Node.js 24.18.0 and npm 11.16.0 (see `.nvmrc` and `packageManager`)
- `uv` 0.11.11
- the committed `package-lock.json` and all three committed `uv.lock` files

Install JavaScript dependencies and run source verification:

```sh
npm ci --strict-allow-scripts
npm run typecheck
npm test
npm run worker:check-locks
npm run audit:python
npm run audit:production
npm run audit:all
```

The Python audit uses a separately locked `pip-audit==2.10.1` toolchain under
`tools/python-audit`. Both npm audits are required. The full build-tool audit is currently clean
because compatible overrides pin patched `tar` and `tmp` releases; removing
those overrides reopens known high/critical Forge-transitive findings.

### Build the macOS DMG

Additional requirements: an Apple Silicon Mac, Xcode command-line tools, and
network access while the pinned Python runtime/wheels are assembled.

```sh
npm run make:mac
```

This command rebuilds the relocatable macOS worker runtime, compiles the native
focus/insertion helper, packages the app, runs the whole-app inventory gate,
and creates DMG and ZIP artifacts under `out/make/`.

Without `LOCALSCRIBE_RELEASE=1`, the app uses an available Apple Development
identity or an ad-hoc signature and remains a validation build.

### Build the Windows Squirrel installer

Additional requirements: Windows 11 x64, PowerShell, Visual Studio C++ Build
Tools, and network access while the pinned runtime/wheels are assembled.

```powershell
npm run make:windows
```

This command rebuilds the relocatable faster-whisper runtime, compiles the
Win32 helper with MSVC, runs the same inventory gate, and creates
`LocalScribe-Setup.exe`, `RELEASES`, and a NuGet package under `out\make\`.
It does not require an NVIDIA GPU merely to build or run the mocked worker
tests; real inference validation does.

## Package isolation

Forge copies broad source directories only long enough to preserve stable
runtime paths, then prunes them before code signing. The release gate checks
ASAR, unpacked native Node modules, and copied resources.

The macOS app may contain only:

- `worker/localscribe_worker`
- `python-runtime`
- `native/macos/active-target`
- the three MLX model manifests

The Windows app may contain only:

- `worker/windows_transformers/localscribe_windows_worker`
- `python-runtime-windows`
- `native/windows/active-target.exe`
- `branding/LocalScribe.ico`
- `faster-whisper-large-v3.json`

The gate rejects missing helpers/runtimes, opposite-platform payloads,
unapproved manifests, tests, source maps, caches, lock/build files, environment
files, credential-like paths, escaping symlinks, development Node modules, and
missing native runtime modules. Release sourcemaps are disabled; a private
diagnostic build must opt in with `LOCALSCRIBE_PRIVATE_SOURCEMAPS=1` and must
not be distributed.

## Signing and CI

Normal CI builds clearly named `UNSIGNED-VALIDATION` artifacts on
`macos-15` arm64 and `windows-latest`. It runs both audits, TypeScript,
Vitest, lock checks, runtime assembly, worker tests, native-helper build/smoke,
Forge make, the inventory gate, SBOM generation, and checksums. These artifacts
are short-lived test evidence, not releases.

The manual release workflow uses a protected `release` environment.
`LOCALSCRIBE_RELEASE=1` fails before packaging unless:

- macOS has a Developer ID Application identity plus Apple notarization
  credentials; or
- Windows has certificate/signing parameters plus an HTTPS timestamp server.

The workflow does not publish a GitHub Release or configure an update feed. It
only produces signed release candidates for review. Detailed credential and
verification requirements are in [docs/RELEASING.md](docs/RELEASING.md).

## What verification does and does not prove

| Evidence | Proves | Does not prove |
| --- | --- | --- |
| TypeScript + Vitest | Contract, policy, persistence, UI, and package-gate behavior covered by tests | OS permissions or physical device behavior |
| Locked runtime build | Pinned Python and dependency graph can be assembled on that runner | Real microphone/GPU inference |
| Forge package/make + inventory | Required resources exist and forbidden files are absent from that produced app | Clean-machine install, update, or uninstall |
| macOS codesign/notary/stapler checks | Signature and Apple notarization for that exact artifact | App behavior after user permission decisions |
| Windows Authenticode check | Publisher signature and timestamp for that exact binary | SmartScreen reputation or NVIDIA compatibility |
| Packaged real-audio smoke | End-to-end inference on the tested machine/model/tier | Support for other machines, GPUs, apps, or languages |

Windows hosted CI has no NVIDIA GPU. A successful Windows CI installer remains
hardware-unvalidated until it passes packaged real-audio tests on the claimed
minimum NVIDIA tier and at least one current RTX generation. A macOS build made
without production credentials remains unsigned/dev evidence even if all
source and inventory checks pass.

## Data and process boundaries

The database is:

- macOS: `~/Library/Application Support/LocalScribe/localscribe.db`
- Windows: `%APPDATA%\LocalScribe\localscribe.db`

SQLite uses WAL mode, transactional migrations, foreign keys, a busy timeout,
and OS keystore-backed encryption for sensitive text. Raw audio is held in
memory, written only to a permission-restricted temporary PCM WAV for
inference, and deleted in a `finally` path. Renderers do not access SQLite,
model paths, or the worker directly.

Core hardening includes renderer sandboxing, context isolation, no Node
integration, strict CSP, validated IPC, Electron fuses that disable RunAsNode,
`NODE_OPTIONS`, CLI inspection, and extra `file://` privileges, plus exact
platform model manifests.

## Licensing

LocalScribe’s original source and assets are proprietary; see
[LICENSE](LICENSE). Third-party components retain their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Generate the production npm
CycloneDX SBOM with:

```sh
npm run --silent sbom > localscribe-sbom.cdx.json
```
