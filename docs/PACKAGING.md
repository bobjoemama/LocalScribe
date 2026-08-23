# macOS packaging policy

LocalScribe treats packaging as a security boundary. The supported package
target is Apple Silicon macOS. Forge copies required source directories, then
reduces them to an explicit arm64 runtime allowlist before signing.

## Allowed custom resources

```text
worker/localscribe_worker/**
python-runtime/**
native/macos/active-target
native/macos/localscribe-fluidaudio-parakeet
model-manifest/parakeet-unified-en-0-6b-coreml-fp16.json
model-manifest/parakeet-unified-en-0-6b-coreml-int8.json
model-manifest/qwen3-asr-0-6b-mlx-bf16.json
model-manifest/qwen3-asr-0-6b-mlx-8bit.json
model-manifest/qwen3-asr-0-6b-mlx-4bit.json
model-manifest/qwen3-asr-1-7b-mlx-bf16.json
model-manifest/qwen3-asr-1-7b-mlx-8bit.json
model-manifest/qwen3-asr-1-7b-mlx-4bit.json
model-manifest/whisper-large-v2-mlx.json
model-manifest/whisper-large-v2-mlx-8bit.json
model-manifest/whisper-large-v2-mlx-4bit.json
model-manifest/whisper-large-v3-mlx.json
model-manifest/whisper-large-v3-mlx-8bit.json
model-manifest/whisper-large-v3-mlx-4bit.json
```

No Auto manifest exists. Auto resolves to an installed concrete profile in the
selected family. Repository, revision, artifact, engine, and profile identity
are curated package policy. Packaging accepts no plugins, arbitrary model URLs,
user manifests, custom loaders, or extra manifest paths.

## Gate order

1. Hash the exact macOS release inputs before the production build.
2. Build main, preload, and renderer with source maps disabled.
3. Reject empty or stale Vite output that predates the invocation.
4. Prune Node modules to the production dependency closure.
5. Reduce packaged metadata to runtime and release fields.
6. Remove tests, maps, caches, shims, and lock/build files.
7. Embed source provenance in `app.asar` and reject source changes during build.
8. Verify the Python runtime, worker, both native helpers, icon, and manifests.
9. Reduce copied resources to the macOS allowlist.
10. Inventory ASAR, ASAR-unpacked, symlinks, native modules, and loose resources.
11. Verify main, preload, renderer assets, identity, and provenance in ASAR.
12. Verify bundle identity, macOS deployment floor, arm64 slices, Electron
    fuses, ASAR header hash, exact entitlements, and deep signature.
13. Open the DMG and ZIP and prove each contains the exact staged signed app.
14. Require the DMG `/Applications` link.
15. Generate and verify macOS runtime/Python SBOMs and SHA-256 checksums.

The gate rejects stale outputs, missing renderer assets, identity or provenance
drift, absent runtime/helper files, unexpected manifests, non-arm64 native
payloads, development modules, executable shims, tests, source maps, bytecode,
caches, project locks, build source, secrets, signing material, and broken or
escaping symlinks.

Python source required by the packaged worker is allowed. Repository project
files and tests are not.

## Local verification

```sh
npm run test:packaging
npm run verify:local:macos
node scripts/release-metadata.mjs --platform darwin --format json
node scripts/verify-release-assets.mjs --platform darwin --candidate
```

The archive verifier compares embedded source provenance with the current
checkout and intentionally rejects an old `out/` artifact after any release
input changes. Rebuild before treating an artifact as current.

The macOS gate runs worker tests through the bundled runtime. Outside the full
gate, use `PYTHONPATH="$PWD/worker"` to ensure a standalone worker test exercises
current source rather than the copy installed by the previous bundle.

## Provenance boundary

The macOS release-input set covers application source, manifests, runtime and
helper builders, entitlements, package inventory, bundle/artifact verifiers,
SBOM generation, packaged smoke, and the macOS gate itself. A checker change
therefore invalidates the package it approved.

The packaged real-model smoke resolves its interpreter, worker, manifests, and
FluidAudio helper only from the candidate app. Its default path is offline and
read-only against the supplied model root. A pending install transaction is
rejected instead of repaired, so local verification does not mutate the user
cache.

## Entitlements and signing

`resources/entitlements.mac.plist` is an exact allowlist. The gate rejects
undeclared entitlements and hardened-runtime escapes such as
`com.apple.security.get-task-allow` and
`com.apple.security.cs.disable-library-validation`. Standalone helpers use
narrow role-specific entitlement profiles instead of inheriting the Electron
main process grants.

Apple Development and ad-hoc signatures establish only local/private
validation identity. They do not prove Developer ID signing, notarization,
stapling, or general Gatekeeper acceptance.

## Runtime SBOM

The CPython component records its exact python-build-standalone distribution,
release tag, and interpreter SHA-256, not merely the CPython version number.
Tests re-hash the interpreter and compare it with the generated SBOM.

Product name, version, repository, bundle identity, supported target, artifact
filenames, SBOM filenames, and checksum filename come from `package.json` and
`src/shared/releasePolicy.mts` through `scripts/release-metadata.mts`. Do not
duplicate changing release identities in scripts or documentation.
