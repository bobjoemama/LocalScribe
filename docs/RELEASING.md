# Local verification and release procedure

LocalScribe intentionally has no GitHub Actions or paid CI/CD pipeline.
Verification and release-candidate creation happen on the target machine. A
successful local command is evidence only for the exact source checkout,
machine, operating system, and artifact it exercised.

`main` remains protected, including for administrators. Changes require a pull
request, resolved review conversations, and linear history. Force pushes and
branch deletion are disabled. No hosted status checks are required.

## Clean checkout

Install the exact toolchain and dependency graph before verification:

```sh
npm install --global npm@11.16.0
npm run toolchain:verify:npm
npm ci --strict-allow-scripts
```

npm dependency install scripts are denied unless their exact reviewed package
version appears in `allowScripts`. All Python dependency graphs and the
separately locked `pip-audit==2.10.1` toolchain come from committed `uv.lock`
files.

## Source verification

Run the platform-independent source gates:

```sh
npm run verify:local
```

This fail-fast script verifies the npm version, production and complete npm
graphs, all committed Python locks, exact Python packages, a clean Windows x64
npm simulation, a locked Windows binary-wheel resolution, ESLint, Ruff for both
workers, the dependency-light Windows worker suite, TypeScript, and the
complete Vitest suite.

## Complete macOS verification

On an Apple Silicon Mac:

```sh
npm run verify:local:macos
```

The command first runs every source gate, then:

1. rebuilds the pinned relocatable Python/MLX runtime;
2. builds the native helper and Forge DMG/ZIP;
3. runs packaged-main, inventory, entitlement, and startup smoke checks;
4. runs the macOS worker tests with the bundled Python and bytecode disabled;
5. emits the core-runtime and locked-Python CycloneDX SBOMs;
6. writes and verifies `out/SHA256SUMS.txt`;
7. performs strict deep code-signature and entitlement verification.

The output remains under `out/` for manual inspection. A normal build uses an
available Apple Development identity or an ad-hoc signature and is a local
validation artifact, not a public release.

The verification script never sets release credentials or model-license
approval. Do not add secrets to the script, repository, npm configuration, or
shell history.

## Local macOS production candidate

Public mode is explicit:

```sh
LOCALSCRIBE_RELEASE=1 npm run make:mac
```

Before running it, the local operator must securely provide:

- a `Developer ID Application:` identity through
  `LOCALSCRIBE_CODESIGN_IDENTITY`;
- `APPLE_ID`;
- `APPLE_APP_SPECIFIC_PASSWORD`;
- `APPLE_TEAM_ID`;
- `LOCALSCRIBE_UNDECLARED_MLX_LICENSE_APPROVED=1` only after documented legal
  approval for the pinned MLX artifacts whose revisions do not declare a
  license.

Forge fails before packaging when a required value is absent or malformed.
Release mode signs the hardened app and DMG, submits both for notarization,
staples them, and runs:

```sh
codesign --verify --deep --strict --verbose=4 LocalScribe.app
xcrun stapler validate LocalScribe.app
spctl --assess --type execute --verbose=4 LocalScribe.app
```

The standalone macOS accessibility helper and bundled Python runtime carry
empty entitlement profiles instead of inheriting the Electron main process
microphone or JIT grants.

## Local Windows verification and signing

Windows work must be performed on a Windows 11 x64 machine. From PowerShell,
install the pinned Node/npm/uv toolchain and dependencies, then run:

```powershell
npm run verify:local:windows
```

On a machine with the intended NVIDIA GPU, require CUDA discovery, NVML
telemetry, pinned runtime versions, and all advertised compute profiles:

```powershell
npm run verify:local:windows -- -RequireCuda
```

When the pinned model is already installed, append
`-CudaModelRoot "$env:APPDATA\LocalScribe\models"` to add a checksum-verified
CUDA model-load and inference smoke without downloading weights.

The command performs the source checks, runtime/helper build, Forge make,
packaged startup smoke, bundled-worker tests and imports, Windows SBOM
generation, Squirrel artifact checks, Authenticode-state checks, and verified
SHA-256 manifest described in [WINDOWS.md](WINDOWS.md). It fails before the
build when Node or npm differs from the exact committed pins.

An ordinary `npm run make:windows` creates an unsigned validation installer.
Public mode additionally requires:

- `WINDOWS_TIMESTAMP_SERVER` using HTTPS;
- either `WINDOWS_SIGN_WITH_PARAMS` for a managed signing flow, or
  `WINDOWS_CERTIFICATE_FILE` plus `WINDOWS_CERTIFICATE_PASSWORD`.

Release mode signs the complete packaged `.exe`/`.dll`/`.node` inventory and
Squirrel artifacts; the target gate verifies every one. Never commit a PFX,
password, token, generated signing command, or decrypted certificate.

## Release-candidate review

Before publication:

1. record `git rev-parse HEAD` and match it to the intended immutable source
   tag and package version;
2. run the complete local verification command on the target platform;
3. verify both platform-specific SBOMs and every entry in
   `out/SHA256SUMS.txt`;
4. re-run notarization or Authenticode checks against the exact candidate;
5. confirm no model weights are embedded in the installer;
6. test model download, offline dictation, tamper rejection, permissions,
   hotkeys, paste fallback, tray, login, and local data paths;
7. on Windows, run real inference on the claimed NVIDIA hardware;
8. test clean install, update, and uninstall before enabling any update feed.

No local command automatically creates a GitHub Release or update feed. Signed
artifacts remain release candidates until a human reviews and publishes them.
If release credentials are unavailable, use the normal local validation build;
never weaken the fail-closed release gates.
