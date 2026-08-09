# Local verification and release procedure

LocalScribe intentionally has no GitHub Actions or paid CI/CD pipeline.
Verification and release-candidate creation happen on the target machine. A
successful local command is evidence only for the exact source checkout,
machine, operating system, and artifact it exercised.

## Clean checkout

Install the exact toolchain and dependency graph before verification:

```sh
nvm install
# Install the exact npm packageManager pin from package.json and the exact
# uv version from .uv-version using your trusted toolchain manager.
npm run toolchain:verify
npm ci --strict-allow-scripts
```

npm dependency install scripts are denied unless their exact reviewed package
version appears in `allowScripts`. All Python dependency graphs and the
separately locked `pip-audit==2.10.1` toolchain come from committed `uv.lock`
files. The audit runs that pinned package as `python -m pip_audit` rather than
through its generated executable shim, so Windows Smart App Control can assess
the pinned Python runtime instead of blocking an unsigned console-script
wrapper.

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

`npm run ci` is an alias for the same gates, and `npm run ci:macos` for the
macOS pipeline below. They exist so the pipeline has a name that does not
change when the underlying script is renamed.

## Local CI

There is no server to catch a broken push, so the check runs before the push
instead. Install it once per clone:

```sh
npm run hooks:install
```

That points `core.hooksPath` at `.githooks`, whose `pre-push` hook runs
`npm run ci` and refuses the push if any gate fails. Pushes that only delete
refs skip it. `git push --no-verify` bypasses it when you mean to.

The hook deliberately does not run the macOS packaging gates: those need an
Apple Silicon machine, a signing identity, and several minutes, and charging
every push that cost would only teach people to bypass the hook. Run
`npm run ci:macos` before publishing a release.

`tests/ciPipeline.test.ts` asserts the pipeline is intact — that `npm run ci`
still reaches the runner, that the runner still invokes every required gate,
that no check names a script that has been renamed away, and that the hook is
present and executable. A hook without the execute bit is silently ignored by
git, which is indistinguishable from having no hook at all.

## Complete macOS verification

On an Apple Silicon Mac:

```sh
npm run verify:local:macos
```

The command first runs every source gate, then:

1. rebuilds the pinned relocatable Python/MLX runtime;
2. builds the native helper and Forge DMG/ZIP;
3. proves main/preload/renderer outputs were created by this invocation and
   embeds a hash of the exact platform release inputs in `app.asar`;
4. runs packaged-main, renderer-asset, source-provenance, inventory,
   entitlement, fuse, ASAR-header, bundle-identity, and startup smoke checks;
5. opens the DMG and ZIP and proves each contains the exact staged signed app;
6. runs the macOS worker tests with the bundled Python and bytecode disabled;
7. emits the core-runtime and locked-Python CycloneDX SBOMs;
8. writes and verifies the versioned checksum manifest named by
   `scripts/release-metadata.mjs`;
9. performs strict deep code-signature and entitlement verification.

This local gate verifies the exact candidate and its generated checksum
manifest. It deliberately does not compare a fresh, non-byte-reproducible DMG
with the README hash of an already-published build. The publication command
below performs that separate downloader-facing check and fails unless the
README matches the exact bytes selected for upload.

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
- a pre-provisioned notarytool Keychain profile name through
  `APPLE_KEYCHAIN_PROFILE`;
- optionally, the non-secret path to a non-default Keychain through
  `APPLE_KEYCHAIN_PATH`;
- `LOCALSCRIBE_UNDECLARED_MLX_LICENSE_APPROVED=1` only after documented legal
  approval for the pinned MLX artifacts whose revisions do not declare a
  license.

Create the profile separately with `xcrun notarytool store-credentials` and
follow Apple’s interactive prompts. The build never accepts an Apple
app-specific password environment variable and never places a notarization
secret in process arguments.

Forge fails before packaging when a required value is absent or malformed.
Release mode signs the hardened app and DMG, submits both for notarization,
staples them, and runs:

These checks run against the exact application path resolved from
`scripts/release-metadata.mjs`; no release command assumes a package version,
architecture, or artifact filename.

The standalone macOS accessibility helper and bundled Python runtime carry
empty entitlement profiles instead of inheriting the Electron main process
microphone or JIT grants.

## Local Windows portable verification

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

The command performs the source checks, transactional runtime/helper build, Forge make,
packaged startup smoke, bundled-worker tests and imports, Windows SBOM
generation, portable-ZIP exact-copy checks, Authenticode-state checks, and a
verified SHA-256 manifest described in [WINDOWS.md](WINDOWS.md). It fails
before the build when Node, npm, or `uv` differs from the exact committed pins.

An ordinary `npm run make:windows` creates an unsigned portable validation ZIP.
It does not create a supported installer and does not configure an update feed.
`LOCALSCRIBE_RELEASE=1` intentionally fails closed on Windows until a supported
installer, passwordless managed signing flow, exact signer/timestamp policy,
and clean-machine install/update/uninstall tests exist. Never publish the
legacy Squirrel diagnostic output or commit a PFX, password, token, generated
signing command, or decrypted certificate.

## Release-candidate review

Before publication:

1. record `git rev-parse HEAD` and match it to the intended immutable source
   tag and package version;
2. run the complete local verification command on the target platform;
3. verify both platform-specific SBOMs and every entry in the versioned
   checksum manifest returned by `scripts/release-metadata.mjs`;
4. re-run the packaged archive and macOS DMG/ZIP checks against the exact
   candidate; an archive from a different source root must fail;
5. re-run notarization or Authenticode checks against the exact candidate;
6. confirm no model weights are embedded in the app package;
7. test model download, offline dictation, tamper rejection, permissions,
   hotkeys, paste fallback, tray, login, and local data paths;
8. on Windows, run real inference on the claimed NVIDIA hardware;
9. test portable extraction and manual replacement; separately test clean
   install, update, and uninstall before enabling any future installer or feed.

No local command automatically creates a GitHub Release or update feed. Signed
artifacts remain release candidates until a human reviews and publishes them.
If release credentials are unavailable, use the normal local validation build;
never weaken the fail-closed release gates.

## GitHub prerelease staging

Release filenames, SBOM filenames, checksum filenames, tag, and repository are
derived from `package.json` and `src/shared/releasePolicy.mts`. A GitHub
prerelease must use a semantic-version prerelease in `package.json` (for
example, a version with `-rc.N` or `-dev.N`). Update `package.json` and
`package-lock.json` together, commit that change, and create the matching
annotated tag before building. Do not retag an existing release.

On macOS, after the signed/notarized candidate passes
`npm run verify:local:macos`, inspect the exact upload inventory:

```sh
node scripts/verify-release-assets.mjs \
  --platform darwin \
  --require-prerelease
```

Before any GitHub mutation, verify that the checkout is clean, the local tag
points to `HEAD`, and the same tag exists on `origin`. Create a **draft**
prerelease with `gh release create <tag> <verified-assets...> --verify-tag
--draft --prerelease`; do not publish it until a human has reviewed the
release description and the exact asset inventory. The verifier rejects empty
files, links, checksum drift, unexpected checksum rows, and any individual
asset at or above GitHub's 2 GiB per-file limit.

### Exact Windows draft-upload handoff

Windows publication is still disabled. These commands are only for the
Windows validator after the release owner has explicitly approved attaching a
fully accepted portable candidate to an already-created **draft prerelease**.
They intentionally stop if the source tag, remote tag, release state, or asset
inventory differs, and they do not use `--clobber`.

```powershell
$ErrorActionPreference = "Stop"
$release = ((& node scripts/verify-release-assets.mjs `
  --platform win32 `
  --require-prerelease) -join "`n") | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Release asset verification failed." }

if (-not [string]::IsNullOrWhiteSpace((git status --porcelain=v1))) {
  throw "The checkout is not clean."
}
$head = (& git rev-parse HEAD).Trim()
$tagCommit = (& git rev-list -n 1 $release.tag).Trim()
if ($LASTEXITCODE -ne 0 -or $tagCommit -ne $head) {
  throw "The local release tag does not point to HEAD."
}
$remoteTag = (& git ls-remote origin "refs/tags/$($release.tag)^{}") -join "`n"
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($remoteTag)) {
  throw "The annotated release tag or its peeled commit is missing from origin."
}
$remoteCommit = ($remoteTag -split "\s+")[0]
if ($remoteCommit -ne $head) {
  throw "The origin release tag does not point to this candidate."
}

$draft = ((& gh release view $release.tag `
  --repo $release.repository `
  --json tagName,isDraft,isPrerelease) -join "`n") | ConvertFrom-Json
if (
  $LASTEXITCODE -ne 0 -or
  $draft.tagName -ne $release.tag -or
  -not $draft.isDraft -or
  -not $draft.isPrerelease
) {
  throw "The matching GitHub draft prerelease is absent or has the wrong state."
}

$assetPaths = @($release.assets | ForEach-Object { [string]$_.path })
& gh release upload $release.tag @assetPaths --repo $release.repository
if ($LASTEXITCODE -ne 0) { throw "GitHub release upload failed." }
& gh release view $release.tag --repo $release.repository --json assets
if ($LASTEXITCODE -ne 0) { throw "GitHub release asset inspection failed." }
```

If `gh release upload` reports an existing asset name, stop and reconcile the
draft. Do not delete or replace a reviewed asset in place.
