# macOS local verification and release procedure

LocalScribe's supported release target is Apple Silicon macOS. Verification and
candidate creation happen locally; there is no hosted CI/CD pipeline. A passing
command is evidence only for the exact checkout, Mac, macOS version, and
artifact it exercised.

## Clean checkout and toolchain

```sh
nvm install
# Install the exact npm packageManager and uv versions declared by the repo.
npm run toolchain:verify
npm ci --strict-allow-scripts
```

npm install scripts are denied unless the exact reviewed package version is in
`allowScripts`. Python application and audit dependencies come from committed
locks.

## Source verification

```sh
npm run verify:local
```

The source gate verifies the toolchain, production and complete dependency
graphs, committed Python locks, dependency audits, ESLint, Ruff, TypeScript,
worker tests, and Vitest. It is source evidence, not packaged or physical
workflow evidence.

`npm run ci` is an alias for the source gates. Install the pre-push hook once
per clone:

```sh
npm run hooks:install
```

The hook runs source CI. It deliberately does not run the slower macOS package
gate, which must be run separately before a binary is staged.

## Complete macOS verification

Run on an Apple Silicon Mac:

```sh
npm run verify:local:macos
```

The command:

1. runs the source gates;
2. rebuilds the pinned relocatable Python/MLX runtime and native helpers;
3. builds fresh main, preload, renderer, DMG, and ZIP outputs;
4. binds exact source provenance into `app.asar`;
5. inventories ASAR, renderer assets, native modules, and loose resources;
6. verifies bundle identity, arm64 slices, fuses, exact entitlements, and deep
   signatures;
7. proves the DMG and ZIP contain the exact staged app;
8. runs worker tests with the bundled runtime;
9. emits CycloneDX runtime and Python SBOMs;
10. writes and verifies the versioned checksum manifest.

Outputs remain under `out/`. A normal build may use Apple Development or ad-hoc
signing and is a local/private validation artifact. It is not evidence of
Developer ID signing, notarization, stapling, or general Gatekeeper trust.

The gate never sets release credentials or model-license approval. Do not add
secrets to scripts, repository files, npm configuration, or shell history.

If notarized distribution is authorized in the future, provision the
Keychain profile separately with `xcrun notarytool store-credentials` and
Apple's interactive prompts. The build must consume only the profile name: it
never places a notarization password in process arguments or accepts one as a
release-script parameter. That future path remains outside the current
private-validation scope.

## Optional packaged real-model smoke

Provide an existing model root and a 16 kHz mono PCM16 fixture:

```sh
npm run verify:local:macos -- \
  --smoke-model-root "$HOME/Library/Application Support/LocalScribe/models" \
  --smoke-audio /absolute/path/to/fixture.wav \
  --smoke-family parakeet-unified-en-0-6b --smoke-tier medium \
  --smoke-mode both --smoke-repeat 2
```

The smoke uses only the candidate's bundled runtime, worker, manifests, and
helpers. Downloads are disabled unless explicitly authorized. The local-only
path rejects pending install transactions and does not repair or delete the
user's model cache.

## Physical acceptance boundary

Before distributing a candidate, test the exact packaged app with a physical
microphone and a normal third-party editable target:

- persisted hold and toggle shortcuts;
- Parakeet after-stop Dictionary correction, insertion, and history;
- Live partial text, one final insertion, cancellation without insertion or
  history, and no stale partial in the next session;
- copy-only fallback without weakening macOS security;
- quit with a warm model and confirm Electron, Python, active-target, and
  FluidAudio processes exit;
- relaunch and verify lazy loading without downloading.

Source tests and packaged smoke do not substitute for this acceptance work.

## Validation release identity

Every uploaded build must use a new semantic prerelease version. Update
`package.json` and `package-lock.json` together, commit the change, create a
matching annotated tag, and rebuild from that exact source. Never reuse a tag
or overwrite an existing release asset with different bytes.

Before any GitHub mutation:

1. record `git rev-parse HEAD` and confirm the worktree is clean;
2. confirm the annotated tag points to `HEAD` and the same commit on `origin`;
3. run the complete macOS gate and physical acceptance;
4. inspect the exact candidate inventory:

   ```sh
   node scripts/verify-release-assets.mjs \
     --platform darwin \
     --require-prerelease
   ```

5. verify the README checksum, SBOMs, and `SHA256SUMS.txt` match the exact
   upload bytes;
6. create a draft prerelease and review its description and assets before
   publication.

No local command automatically creates a GitHub Release or update feed. If an
asset name already exists, stop and reconcile it; do not delete or replace a
reviewed asset in place.

## Binary trust boundary

The current intended distribution class is private/local validation, not Mac
App Store distribution. Publishing source on GitHub does not make an
Apple Development or ad-hoc signed binary publicly trusted. If broad binary
distribution is later desired, Developer ID signing, hardened runtime,
notarization, stapling, Gatekeeper assessment, and clean-machine testing remain
separate requirements for the exact artifact.

If automatic updates remain disabled, document manual replacement and data
preservation behavior. Never weaken a fail-closed gate to make a validation
artifact appear production-ready.
