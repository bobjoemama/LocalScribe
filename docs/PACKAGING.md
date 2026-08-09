# Packaging policy

LocalScribe treats packaging as a security boundary. Forge’s copy stage uses
whole source directories only to preserve the runtime paths expected by the
main process. `afterCopyExtraResources` immediately reduces those copies to an
OS/architecture allowlist before Electron Packager signs the app.

## Allowed custom resources

macOS arm64:

```text
worker/localscribe_worker/**
python-runtime/**
native/macos/active-target
model-manifest/whisper-large-v3-mlx.json
model-manifest/whisper-large-v3-mlx-8bit.json
model-manifest/whisper-large-v3-mlx-4bit.json
model-manifest/qwen3-asr-1-7b-mlx-bf16.json
model-manifest/qwen3-asr-1-7b-mlx-8bit.json
model-manifest/qwen3-asr-1-7b-mlx-4bit.json
model-manifest/qwen3-asr-0-6b-mlx-bf16.json
model-manifest/qwen3-asr-0-6b-mlx-8bit.json
model-manifest/qwen3-asr-0-6b-mlx-4bit.json
model-manifest/whisper-large-v2-mlx.json
model-manifest/whisper-large-v2-mlx-8bit.json
model-manifest/whisper-large-v2-mlx-4bit.json
```

Windows x64:

```text
worker/windows_transformers/localscribe_windows_worker/**
python-runtime-windows/**
native/windows/active-target.exe
native/windows/crispasr/LICENSE
native/windows/crispasr/THIRD_PARTY_NOTICES.txt
native/windows/crispasr/crispasr.dll
native/windows/crispasr/cudart64_12.dll
native/windows/crispasr/ggml-base.dll
native/windows/crispasr/ggml-cpu.dll
native/windows/crispasr/ggml-cuda.dll
native/windows/crispasr/ggml.dll
branding/LocalScribe.ico
model-manifest/faster-whisper-large-v3.json
model-manifest/qwen3-asr-1-7b-crisp-f16.json
model-manifest/qwen3-asr-1-7b-crisp-q8-0.json
model-manifest/qwen3-asr-1-7b-crisp-q4-k.json
model-manifest/qwen3-asr-0-6b-crisp-f16.json
model-manifest/qwen3-asr-0-6b-crisp-q8-0.json
model-manifest/qwen3-asr-0-6b-crisp-q4-k.json
model-manifest/faster-whisper-large-v2.json
```

No `auto` manifest exists. Large-v3 is the default catalog family; Qwen3-ASR
0.6B, Qwen3-ASR 1.7B, and large-v2 are curated and addable, not extension
points. Mac packages carry exactly three MLX manifests per family. Windows
Whisper tiers share one physical manifest per family and use a trusted
compute-profile allowlist; Windows Qwen tiers use three distinct GGUF manifests
per family. Repository, revision,
artifact, engine, and profile identity remain curated code/package policy.
Packaging does not accept plugins, arbitrary model URLs, user manifests,
custom code/loaders, or extra manifest paths. The catalog's revision and
per-file SHA-256 pins are described in
[MODEL_CATALOG.md](MODEL_CATALOG.md).

## Gate order

1. Forge hashes the exact platform release inputs before the production build.
2. Vite builds main, preload, and renderer with source maps disabled.
3. Forge rejects empty or stale Vite files that predate this package invocation.
4. Forge prunes Node modules to the production dependency closure.
5. The staged package manifest is reduced to runtime and release metadata.
6. Package tests, maps, caches, shims, and lock/build files are removed.
7. The source hash is embedded in `app.asar`; any input change during the build
   fails the package instead of silently producing a mixed-source artifact.
8. Platform runtime, worker, helper, icon, and manifests are checked before copy.
9. Copied resources are reduced to the platform allowlist.
10. ASAR, ASAR-unpacked, symlinks, and all custom resources are inventoried.
11. Main, preload, renderer HTML, every renderer asset reference, package
    identity, and embedded source provenance are checked inside `app.asar`.
12. Only a passing app enters platform signing/notarization.
13. The final packaged directory is inventoried again before a maker runs.
14. On macOS the app identity and deployment floor from the central release
    policy, icon, supported architecture slice,
    Electron fuses, embedded ASAR header hash, entitlements, and deep signature
    are verified from the artifact, not inferred from Forge configuration.
15. Forge opens both the DMG and ZIP, verifies that each contains the exact
    staged signed app, and requires the DMG `/Applications` link.
16. On Windows Forge clears the exact ZIP and legacy-Squirrel maker targets
    after rejecting linked/reparse parents, then requires artifacts created by
    the current invocation.
17. The Windows portable ZIP is extracted to a private directory and every
    file is hashed against the staged app. Legacy Squirrel is disabled; its
    diagnostic opt-in must pass exact PE DATA/#131 payload, RELEASES, nupkg,
    and embedded source-provenance checks.

The gate rejects:

- stale renderer/main/preload output or source changes during packaging;
- a missing, empty, externally referenced, or source-mapped renderer asset;
- package version, product identity, target, or source-provenance drift;
- an absent bundled Python executable or native helper;
- missing worker entrypoints or model manifests;
- opposite-platform worker/runtime/native payloads;
- extra or legacy manifests;
- development Node modules or executable shims;
- test directories/files, source maps, bytecode/caches, and repository locks;
- Swift/C/C++/PowerShell/shell build sources in the app;
- `.env`, credential/secret-like paths, signing material, and escaping/broken
  symlinks.

Runtime package metadata and upstream license files are retained. Python source
needed to import the worker/runtime is allowed; repository project files and
tests are not.

## Local verification

Packaging policy tests:

```sh
npm run test:packaging
```

Mac app and installer:

```sh
npm run verify:local:macos
node scripts/release-metadata.mjs --platform darwin --format json
node scripts/verify-release-assets.mjs --platform darwin --candidate
```

`verify-packaged-archive.mjs` compares the archive’s embedded source root with
the current checkout. It intentionally rejects an old `out/` package after any
release input changes; rebuild before treating that artifact as current.

The macOS gate runs the worker unit tests through
`resources/python-runtime/venv`, and `npm run make:mac` refreshes that venv from
`worker/` first. Running that unittest command on its own tests whatever copy of
`localscribe_worker` the last bundle installed, not the current source; add
`PYTHONPATH="$PWD/worker"` when checking a worker edit outside the gate.

## What source provenance binds on macOS

`MAC_RELEASE_INPUTS` covers the macOS gate scripts as well as the app's own
inputs: `verify-local-macos.sh`, `smoke-packaged-macos.sh`, the bundle,
entitlement, and artifact verifiers, and the SBOM generator. The Windows list
already bound its own gate scripts; the macOS list bound only the worker-runtime
builder, so a weakened checker could re-approve a signed app that still reported
the same source provenance. `verify-local-source.mjs`, `verify-packaged-main.mjs`,
and `verify-packaged-archive.mjs` gate both platforms and are in the common list.
`tests/packageProvenance.test.ts` fails if one of them stops being covered.

## What the entitlement gate proves

`resources/entitlements.mac.plist` is the allowlist, not a floor. The gate used
to assert only that `com.apple.security.cs.allow-jit` and
`com.apple.security.device.audio-input` were present on the signed app, and a
presence check cannot reject an addition: a build that also carried
`com.apple.security.get-task-allow` (debuggable release — any process the user
runs can attach and read decrypted transcripts out of memory) or
`com.apple.security.cs.disable-library-validation` passed unchanged.
`scripts/macos-entitlement-policy.mts` now compares the signature with the
declared plist as an exact set, rejects a plist that itself declares a
hardened-runtime escape, and names the six escapes explicitly.
`tests/macosEntitlementPolicy.test.ts` covers both directions; the verifier
prints the entitlements that actually shipped rather than "capabilities
present".

## What the runtime SBOM says about CPython

`cpython@3.12.13` does not identify a build. `uv python install 3.12.13`
resolves to a python-build-standalone release, and two releases can both call
themselves 3.12.13 while shipping different binaries. The macOS CPython
component therefore carries the distribution directory
(`cpython-3.12.13-macos-aarch64-none`), the release tag from that directory's
`BUILD` file, and a SHA-256 of the interpreter that shipped
(`bin/python3.12`). `tests/runtimeSbomSecurity.test.ts` re-hashes the
interpreter on disk and compares it with the digest in the generated SBOM.

Startup verifies the packaged loose-resource tree before anything else, with
synchronous reads on the main thread: 12,217 files and 1.01 GB on the current
macOS package. The scan reuses one 1 MiB read buffer instead of allocating one
per file, which measured 0.65 s against 0.80 s with a warm page cache.

The Windows app and portable package must be produced on Windows:

```powershell
npm run verify:local:windows
npm run verify:local:windows -- -RequireCuda
```

The complete gate builds and smokes the package, validates the target-native
module inventory and both SBOMs, checks every packaged `.exe`, `.dll`, and
`.node`, and proves the portable ZIP is an exact copy of the staged package.
The Authenticode result may be `NotSigned` or an existing valid vendor
signature for a validation build. Public Windows release mode is intentionally
disabled until a supported installer, passwordless signing flow, and physical
install/update/uninstall acceptance exist.

Product name, package version, repository, bundle identity, supported target,
artifact filenames, SBOM filenames, and checksum filename come from
`package.json` plus `src/shared/releasePolicy.mts` through
`scripts/release-metadata.mts`. Do not duplicate a current version or output
filename in a release script.
