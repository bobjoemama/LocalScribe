# LocalScribe macOS delivery plan

LocalScribe's active product and release scope is Apple Silicon macOS. This
plan separates implemented source behavior from evidence that still requires a
physical Mac and an exact packaged artifact.

## Signed in-app updates — public dev.25, checked 19 October 2026

Devesh approved signed in-app updates on 19 October. The public release adds
GitHub metadata checks, explicit downloads/restarts, System → Updates and
content-free native-insertion diagnostics. Existing dev.24 users need one manual
DMG replacement. The other Mac's insertion recovered before these changes were
delivered; the recovery has no established root cause.

- Published [dev.25](https://github.com/bobjoemama/LocalScribe/releases/tag/v0.1.0-dev.25)
  at `2026-10-20T02:04:15Z` (19 October, Pacific time). The annotated tag resolves
  to merged PR #44, `c31c8c89ff2605b0e1310334b0634ad1479087ef`.
- The fresh Developer ID-signed app and DMG are Apple-notarized, stapled and
  Gatekeeper-accepted. App submission `8adb9f38-6cdd-422a-aa32-cace5f4d6e5c` and
  DMG submission `8ad734d7-fe04-4dd9-bf57-b082bd4877da` both returned Accepted.
- All six public files were independently downloaded without credentials. Their
  names, lengths and SHA-256 values match GitHub's digests and the upload inventory;
  the checksum manifest passes 4/4. The public DMG, mounted app and ZIP-extracted
  app pass strict signatures, stapler and Gatekeeper. Both apps are arm64,
  macOS 14+, bundle `com.localscribe.desktop`, team `H2L3Q52987`.
- Embedded source provenance matches all 373 tagged inputs:
  `b2b09639ac1da02d38998eabac11b1ac2b60907fcb0bc5b4142b09b6ebe880a7`.
  The separate update-feed SHA-256 is
  `59caa59991086da5b617da47b1cffdea70d6e1c9b22493841e09a71c689b9c8f`.
  Versioned `SHA256SUMS.txt` remains the authoritative four-file content inventory.
- Source verification passed 1,816 tests. The fresh package passed 10 runtime
  tests, 73 Python tests, imports, entitlements and isolated startup/shutdown.
  A signed isolated Squirrel update/relaunch, light/dark Updates and real
  Settings/Notes save preparation passed before publication. The actual updater
  metadata backend discovered public dev.25 with no native download.

Public receipt: `/tmp/localscribe-dev25-public-test-20261019-0rayzp/result.json`;
metadata receipt: `/tmp/localscribe-dev25-public-discovery-20261019.json`.
No fresh physical microphone/insertion or production LocalScribe-to-LocalScribe
upgrade was exercised. The focus-stealing Accessibility harness remains unrun;
the installed working app was not restarted or replaced. Exact commands and
other verification limits are in [tasklist](../tasklist.md).

## Previous public Mac download — checked 19 October 2026

- [x] Confirm the previous public release was
  [dev.24](https://github.com/bobjoemama/LocalScribe/releases/tag/v0.1.0-dev.24),
  including the 250,866,133-byte arm64 DMG then linked in the README.
- [x] Download the public DMG and confirm SHA-256
  `e73f16d1391a892d4e3a757bcf98134ec9d964ff26107ceec5f9e8e61cc0c587`
  against GitHub's asset digest and the published checksum manifest.
- [x] Verify Developer ID/team H2L3Q52987, strict signatures, stapled
  notarization tickets and Gatekeeper acceptance for both DMG and enclosed app.
  The public-release bundle verifier passes; the app is arm64, macOS 14.0+,
  with the Applications drag-and-drop link. No app launch or installation occurred.
- [x] Audit the newcomer README and clarify Intel exclusion, permission menus
  and shortcut conflicts. Models download separately before Apply; no developer
  tools are required. The iPhone and Mac READMEs link to each other.

The release tag resolves to `d61e7c9`, whose tree equals merged `88a845a`.
This historical receipt covers dev.24; dev.25 is recorded above.
Fresh installation, microphone permission and insertion on a second physical
Mac were not exercised in this audit. The model comparison below remains proposed.

## 1. Local inference

Implemented:

- Parakeet Unified EN 0.6B as the fresh-install recommendation;
- pinned FluidAudio/Core ML/ANE runtime for English after-stop and Live modes;
- Parakeet High FP16 and Medium INT8 profiles, with no Low/Q4 profile;
- curated Qwen3-ASR through MLX Audio and Canary-Qwen through Metal alternatives;
- Auto, High, Medium, and Low choices, limited to profiles available for the
  selected family;
- revision-, size-, and SHA-256-pinned model installation;
- explicit download and Apply transactions;
- no inference-time downloads, family substitution, arbitrary URLs, plugins,
  custom code, or network fallback.

High is always original, unquantized precision. Quantization belongs only in
lower profiles. Auto chooses only within the user-selected family.

Remaining product evidence:

- Devesh's 16 October accuracy-first Mac model/runtime research is complete;
  the proposed comparison is tracked in
  [model comparison evidence](MODEL_COMPARISON_EVIDENCE.md#accuracy-first-research--16-october-2026).
  Runtime changes, model additions and a default replacement remain proposed.
- matched accuracy, warm/cold latency, and memory benchmarks on target Apple
  Silicon hardware;
- longer-duration Live and after-stop behavior with real recordings;
- corpus-based comparison before making performance or accuracy claims.

## 2. Model lifecycle

Family and performance controls stage a pending selection. **Apply model** is
the commit boundary: it verifies the exact target before unloading the warm
model, loads with downloads disabled, and commits only after ready is reported.
A failure leaves the prior committed selection authoritative and reports
whether restoring its runtime succeeded.

Only one large runtime should be resident. The active model remains warm
between dictations, while temporary accelerator caches are cleared. Quitting
LocalScribe must stop Electron, the Python worker, the active-target helper,
and the FluidAudio helper.

## 3. Desktop workflow

Implemented and source-tested:

- floating dictation pill and settings;
- 16 kHz mono PCM16 AudioWorklet capture;
- push-to-talk and toggle shortcuts;
- target-guarded insertion with copy-only fallback;
- after-stop final insertion and Live partial/final/cancel state handling;
- history, dictionary, snippets, app profiles, deterministic cleanup, and
  scratchpad;
- local SQLite persistence with macOS-keystore protection for sensitive text;
- macOS permission and status surfaces.

Remaining physical acceptance:

- microphone permission and capture on a fresh user profile;
- persisted hold/toggle shortcut behavior;
- insertion into ordinary third-party editable fields;
- copy-only fallback without weakening macOS security;
- Dictionary correction, final insertion, and history as one workflow;
- Live partials, one final insertion, cancellation without insertion/history,
  and no stale partial in the next session;
- tray/menu, login item, multi-monitor behavior, and failure recovery;
- warm quit, relaunch, and lazy load without downloading.

## 4. Package integrity

Implemented:

- macOS worker, runtime, helper, model-manifest, and branding allowlists;
- ASAR, native-module, and loose-resource inventory;
- rejection of tests, source maps, caches, locks, secrets, signing material,
  unexpected manifests, and escaping symlinks;
- release source maps disabled;
- production dependency audits, runtime provenance, exact entitlement policy,
  deep signature checks, CycloneDX SBOMs, and SHA-256 manifests.

The generated Python runtime, native helper outputs, model weights, and package
artifacts are ignored by Git and recreated from pinned source and locks.

## 5. macOS validation distribution

The supported local gate is:

```sh
npm run verify:local:macos
```

It creates arm64 DMG and ZIP validation artifacts under `out/`, plus SBOMs and
checksums. Apple Development and ad-hoc signatures are acceptable only for
private/local validation. They do not establish Developer ID, notarization,
stapling, or public Gatekeeper trust.

The current scope is validation distribution, not Mac App Store distribution.
Source publication on GitHub is a separate decision from binary trust. Do not
describe a validation artifact as notarized or generally installable unless
the exact uploaded bytes passed those additional gates.

Remaining release QA:

- exact source/tag/version/artifact identity;
- physical workflow acceptance on the exact packaged app;
- clean-profile install, first-launch permissions, offline dictation, manual
  upgrade, and uninstall behavior;
- inspection of the exact upload inventory and checksum manifest.

## 6. Publication discipline

Local verification never creates a GitHub Release or update feed. Before any
approved GitHub binary publication:

1. use a new semantic prerelease version and annotated tag;
2. verify the tag, package version, model manifests, SBOMs, and checksums match;
3. run the complete source and macOS package gates;
4. complete physical acceptance on the exact candidate;
5. inspect the draft release and asset inventory;
6. never overwrite or silently replace an existing asset.

Publish the static update feed using [Releasing](RELEASING.md#in-app-update-feed).
Keep the manual DMG fallback and preserve existing versioned assets.
