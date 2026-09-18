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
native/macos/liblocalscribe-canary.dylib
model-manifest/canary-qwen-2-5b-gguf-bf16.json
model-manifest/canary-qwen-2-5b-gguf-q8.json
model-manifest/canary-qwen-2-5b-gguf-q4.json
model-manifest/parakeet-unified-en-0-6b-coreml-fp16.json
model-manifest/parakeet-unified-en-0-6b-coreml-int8.json
model-manifest/qwen3-asr-0-6b-mlx-bf16.json
model-manifest/qwen3-asr-0-6b-mlx-8bit.json
model-manifest/qwen3-asr-0-6b-mlx-4bit.json
model-manifest/qwen3-asr-1-7b-mlx-bf16.json
model-manifest/qwen3-asr-1-7b-mlx-8bit.json
model-manifest/qwen3-asr-1-7b-mlx-4bit.json
model-manifest/whisper-large-v3-mlx.json
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
13. Preflight the ZIP's canonical paths, Unix modes, expansion bounds, and
    in-bundle relative symlinks before extraction; then open the DMG and ZIP and
    prove each contains the exact staged signed app.
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
npm run verify:local:macos -- --release-candidate --require-accessibility
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

The macOS release-input set covers application source, source tests, CI/hook,
lint, typecheck, audit and test-runner policy, the native UI fixtures,
manifests, runtime and helper builders, entitlements, package inventory,
bundle/artifact verifiers, SBOM generation, packaged smoke, and the macOS gate
itself. A checker change therefore invalidates the package it approved.

Release-candidate mode additionally requires every recursively selected input
to be Git-tracked and the worktree to contain no tracked or non-ignored
untracked changes. Ordinary source and package verification does not impose
that clean-tree rule, so pre-commit validation can exercise intended edits and
ignored build output remains harmless.

Native helpers are built under ignored `out/runtime-staging/`. Forge promotes
them atomically only for signing and copying, then restores and verifies the
tracked recovery inputs byte-for-byte and mode-for-mode, including failure and
process-exit paths.

The packaged real-model smoke resolves its interpreter, worker, manifests, and
FluidAudio helper only from the candidate app. Its default path is offline and
read-only against the supplied model root. A pending install transaction is
rejected instead of repaired, so local verification does not mutate the user
cache.

## Entitlements and signing

Every signed Mach-O has a role-specific exact entitlement allowlist. The main
app is compared key-for-key and value-for-value with
`resources/entitlements.mac.plist`; renderer, GPU, and utility helpers are
compared with `resources/entitlements.mac.helper.plist`; and standalone native
helpers and the bundled Python runtime must carry no entitlements.

Electron's Plugin helper is the only exception to the general ban on
`com.apple.security.cs.allow-unsigned-executable-memory` and
`com.apple.security.cs.disable-library-validation`. It is compared exactly with
`resources/entitlements.mac.plugin.plist`, which permits only those two
capabilities. The exception does not apply to any other process and does not
permit universally forbidden capabilities such as
`com.apple.security.get-task-allow`. Any undeclared entitlement, changed value,
unrecognized nested application, unchecked nested helper Mach-O, or role
mismatch fails the gate.

Apple Development and ad-hoc signatures establish only local/private
validation identity. They do not prove Developer ID signing, notarization,
stapling, or general Gatekeeper acceptance.

## Runtime SBOM

The CPython source is pinned to one python-build-standalone release URL and
archive SHA-256. The core SBOM records that pin and hashes the exact signed
interpreter and FluidAudio helper inside the candidate app, not restored source
bytes. The companion Python SBOM is reconciled against packaged `.dist-info`
metadata and records the one compatible wheel URL and lock SHA-256 selected for
each installed distribution; non-installed platform alternatives are removed.

`SHA256SUMS.txt` uses flat release asset basenames even though Forge keeps local
DMG and ZIP outputs in nested build directories. A downloaded set of the five
release assets can therefore be verified with standard `shasum -a 256 -c`.

Product name, version, repository, bundle identity, supported target, artifact
filenames, SBOM filenames, and checksum filename come from `package.json` and
`src/shared/releasePolicy.mts` through `scripts/release-metadata.mts`. Do not
duplicate changing release identities in scripts or documentation.
