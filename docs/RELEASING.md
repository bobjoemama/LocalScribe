# macOS local verification and release procedure

LocalScribe's supported release target is Apple Silicon macOS. A read-only
GitHub Actions workflow runs source verification for non-draft pull requests
and direct pushes to `main`; candidate creation and all packaged-app
verification happen locally. A passing command is evidence only for the exact
checkout, Mac, macOS version, and artifact it exercised.

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
and Vitest, including dependency-free cross-language policy checks. Full Python
worker tests run later against the bundled runtime in the macOS package gate.
Source verification is not packaged or physical workflow evidence.

`npm run ci` is an alias for the source gates and is the exact entry point used
by hosted pull-request CI. The workflow has read-only repository permission,
uses SHA-pinned actions, receives no release secrets, uploads no artifacts, and
does not persist checkout credentials or hosted caches, and never runs on
`pull_request_target`. Its stable required-check name is `Source verification`,
and uv is forbidden from downloading an implicit Python runtime. Install the
pre-push hook once per clone:

```sh
npm run hooks:install
```

The hook runs the same source CI before a push. Neither source-CI path runs the
slower macOS package gate, which must be run separately before a binary is
staged.

## Dependency audit review, 4 October 2026

The compatible refresh pins Electron 43.7.7 and updates existing brace-expansion,
fast-uri, http-cache-semantics and Undici lock entries. The separate Python audit
project updates only urllib3 to 2.8.0; the speech worker's dependency lock and
bundled inference runtime are unchanged. The production audit must stay clean,
and the full audit gate rejects any runtime/Electron advisory even though npm
classifies Electron as a development dependency.

The full audit still reports an exact build-only residual. The gate records
specific nodes, ancestors, severities, affected ranges and advisory URLs rather
than accepting arbitrary build dependencies. Braces 3.0.3 has no published fix;
Forge's inspected glob caller uses its own build path and the fixed
`**/.bin/**/*` pattern, with no dictation/user-input pattern. Existing
extract-zip and image-size build paths retain their scoped review. The corrected
image-size JXL/HEIF range excludes locked 0.7.5; its ICNS advisory remains.

Sources: [Electron release](https://github.com/electron/electron/releases/tag/v43.7.7),
[unpatched braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
[image-size ICNS](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr),
[corrected JXL/HEIF range](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq),
[urllib3 security fixes](https://github.com/urllib3/urllib3/releases/tag/2.8.0).
Http-cache-semantics 4.3.0 falls outside the current audit range, but the
[maintainer disputes the advisory](https://github.com/kornelski/http-cache-semantics/issues/56);
do not describe the version refresh as verified remediation of that report.
Full-audit success means the exact reviewed residual was recognized, not that
all build tooling is vulnerability-free. Any changed node/advisory/path fails
and requires another investigation.

## Complete macOS verification

Run on an Apple Silicon Mac:

```sh
npm run verify:local:macos -- --release-candidate --require-accessibility
```

`--release-candidate` rejects missing or untracked provenance inputs and any
tracked or non-ignored untracked worktree change before the build. Ignored
package output such as `out/` does not make the check dirty. The flag is
deliberately absent from ordinary `npm run verify:local` and pre-push checks so
maintainers can verify intended pre-commit edits. `LOCALSCRIBE_RELEASE=1`
enables the same release-candidate check automatically.

The command:

1. runs the source gates and native settings-layout harness;
2. rebuilds the pinned relocatable Python/MLX runtime and native helpers;
3. builds fresh main, preload, renderer, DMG, and ZIP outputs;
4. binds exact source and release-gate provenance into `app.asar`;
5. inventories ASAR, renderer assets, native modules, and loose resources;
6. verifies bundle identity, arm64 slices, fuses, exact entitlements, and deep
   signatures;
7. preflights the ZIP before extraction and proves the DMG and ZIP contain the
   exact staged app;
8. runs worker tests with the bundled runtime;
9. emits CycloneDX runtime and Python SBOMs bound to the exact packaged native
   binaries, installed Python inventory, and selected locked wheel hashes;
10. writes and verifies the versioned checksum manifest.

Outputs remain under `out/`. A normal build may use Apple Development or ad-hoc
signing and is a local/private validation artifact. It is not evidence of
Developer ID signing, notarization, stapling, or general Gatekeeper trust.

The gate never sets release credentials or model-license approval. Do not add
secrets to scripts, repository files, npm configuration, or shell history.

## Local signed UI candidate without notarization

For an authorized local review build, `LOCALSCRIBE_LOCAL_SIGNED_CANDIDATE=1`
enables hardened-runtime signing for the app, helpers, and bundled Python while
`LOCALSCRIBE_RELEASE=0` keeps notarization and timestamp service calls disabled.
Set `LOCALSCRIBE_CODESIGN_IDENTITY` to the existing Developer ID Application
identity used by the installed app; this mode refuses Apple Development or
ad-hoc identities. Keep the bundle ID and app name unchanged. Verify the
candidate's designated code requirement against the installed app before any
replacement; matching identity is necessary but does not prove that runtime
permissions and encrypted storage will work after activation.

When only renderer source changed and the existing pinned Python runtime and
staged native helpers are present, Forge's package API can reuse them without
running `worker:bundle`. It still builds fresh main/preload/renderer code and
the Accessibility helper, signs the candidate, and checks source provenance,
resources, entitlements, native imports, fuses, and the bundle. Native modules
rebuild sequentially using the shared Electron header cache; no module is
excluded from rebuild checks. Pass an explicit,
unused `outDir` beneath `out/` to preserve earlier artifacts. This build must
not target `/Applications` or any running application bundle.

Invoke the package API from a regular Node script or CommonJS `node -e`
expression. `--input-type=module` is an eval-only flag that propagates to
Forge's forked file-based rebuild workers and prevents those workers from
starting. The normal Forge CLI does not use that flag.

Local signed candidates have no new notarization ticket and are not public
release artifacts. Building one does not install or launch it. Installing,
activating, real dictation testing, and notarization remain separate authorized
steps. The same model files and user data must stay in place during an update.

For an authorized notarized build, provision the Keychain profile separately
with `xcrun notarytool store-credentials` and Apple's interactive prompts:

```sh
xcrun notarytool store-credentials "localscribe-notary"
```

Use the Apple Developer account and team associated with the intended
Developer ID Application certificate. Enter an Apple app-specific password
only at the local password prompt, never in chat, shell history, or a repository
file. An installed signing certificate alone does not authenticate the notary
service. If a profile already exists, reuse its name after validating access:

```sh
xcrun notarytool history --keychain-profile "localscribe-notary"
```

The build must consume only the profile name: it
never places a notarization password in process arguments or accepts one as a
release-script parameter. Select the intended `Developer ID Application:`
identity with `LOCALSCRIBE_CODESIGN_IDENTITY`, set `APPLE_KEYCHAIN_PROFILE` to
the validated profile name, and use `LOCALSCRIBE_RELEASE=1` for the build.
This mode enables hardened runtime, app notarization and stapling, followed by
DMG notarization, stapling, and Gatekeeper assessment. It does not publish to
GitHub or change repository visibility.

The release build checks the actual packaged model catalog's license
declarations and requires its manifest set to match the packaging allowlist.
There is no environment-variable waiver. Whisper is excluded from the catalog,
worker, and packaged manifests. An Apple developer account does not grant model
redistribution rights. See
[CLEAN_ROOM.md](CLEAN_ROOM.md).

Check the exact app and DMG with `xcrun stapler validate` and the release
artifact verifier's `--public-release` mode before describing them as
notarized. Apple signing is an identity/trust mechanism, not a replacement for
the Apache or third-party software licenses. See Apple's
[Developer ID overview](https://developer.apple.com/developer-id/) and
[notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).

Changing from an Apple Development identity to a different Developer ID team
can require renewed macOS Accessibility consent on existing installations.
Preserve user data and explain the identity transition; never reset TCC or
disable system protections automatically.

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

The default packaged-app shutdown smoke starts the candidate in a dedicated,
owned POSIX process group and requires that entire group to disappear after
termination, including children created after shutdown begins. It exercises an
idle startup. It does not deterministically put a real model worker in an
active or finalizing transaction, so worker retirement in those states remains
part of the physical warm-model acceptance below.

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

5. verify the README explains manifest verification and confirm the SBOMs and
   `SHA256SUMS.txt` match the exact upload bytes;
6. create a draft prerelease and review its description and assets before
   publication.

The checksum manifest is the authoritative digest inventory. Release notes may
repeat the exact DMG and ZIP digests for convenience, but README prose must not
embed a candidate hash: changing the README after building would change the
source commit and break exact source/tag/artifact provenance.

Neither the source workflow nor any local command automatically creates a
GitHub Release or update feed. If an asset name already exists, stop and
reconcile it; do not delete or replace a reviewed asset in place.

## Binary trust boundary

Repository access and binary trust are independent. The repository is currently public; changing its visibility requires separate authorization. Developer ID signing and notarization support direct downloads outside
the Mac App Store and do not require making the repository public. Existing
Apple Development or ad-hoc signed releases do not gain trust retroactively.
Developer ID signing, hardened runtime, notarization, stapling, Gatekeeper
assessment, and clean-machine testing are separate requirements for each
artifact intended for straightforward distribution.

If automatic updates remain disabled, document manual replacement and data
preservation behavior. Never weaken a fail-closed gate to make a validation
artifact appear production-ready.

## October 7 distribution status

[dev.24](https://github.com/bobjoemama/LocalScribe/releases/tag/v0.1.0-dev.24)
was published at 2026-10-07T17:32:23Z. Its Developer ID-signed app and DMG are
notarized, stapled, and accepted by Gatekeeper. The annotated `v0.1.0-dev.24`
tag points to `d61e7c9`, the exact artifact source;
[PR #39](https://github.com/bobjoemama/LocalScribe/pull/39) merged as `88a845a`
on `main` with the same source tree. All five published assets—the DMG, ZIP,
two SBOMs, and checksum manifest—have verified sizes and SHA-256 values
matching the local release inventory.

The full public macOS gate passed 1,652 source tests (two existing skips),
73 bundled-worker tests, native boundary checks, and packaged resource and
runtime verification. The exact DMG and ZIP passed archive verification and
packaged startup/shutdown checks.

The installed dev.24 app preserves the existing signing identity and 63 saved
history entries. All 11 tracked processes from the old warm session exited after
Command-Q before replacement; the previous dev.21 app remains recoverable in
Trash. The new app launched with Microphone and Accessibility granted, and
Canary High loaded successfully. Microphone recording and physical browser text
insertion were not tested against dev.24; these checks do not replace that
acceptance work.

The separate iPhone app's 0.7.1/build 11 uploaded successfully at
2026-10-07T17:06:14Z. Apple reports **PROCESSING**; no eligible portal build is
available, external beta review has not been submitted, and there is no public
TestFlight invitation URL. Upload completion does not establish eligibility or
review approval. See the authoritative
[current iOS beta status](https://github.com/bobjoemama/LocalScribeiOS/blob/main/tasklist.md#current-ios-beta-status)
and [installation guide](https://github.com/bobjoemama/LocalScribeiOS/blob/main/docs/INSTALLATION.md).

## Audio cache recovery correction

The reported completion failure was reproduced before inference: launching
another app instance removed the running app's private temporary audio directory,
and staging its next WAV failed with ENOENT. The installed app's missing directory
was restored at the same path with private permissions and a verified process
lease; its next actual dictation completed without restarting or unloading Canary.

The dev.22 correction leases each cache to its owning process. Startup cleanup
removes a marked cache only when its owner is definitively gone; it preserves live,
unmarked and uncertain roots. Completion securely restores its original cache
when needed, preserving the warm worker's temporary-root policy. Tests exercise
two real processes, dead-owner cleanup, missing-root recovery, cancellation and
filesystem failures. Diagnostics and the pill use fixed storage-error codes and
actionable messages, without private paths or dictated text. New public artifacts
require the usual exact-source release gate; published assets are immutable.

## dev.24 changes

The dev.22 private artifact was validated locally and never published. Public
dev.24 includes the audio-cache recovery correction, retryable native helper
metadata and fresh Accessibility status (granted, denied or unavailable), browser
target continuity through Accessibility activation, and guards for secure or disabled editors.
Permission and copy fallback advice reflects current readiness. Settings confirm
discarding drafts, preserve edits during pending saves, support Command-S, and
show pending and failure feedback. The insertion fallback message was measured
to fit the original pill size.
