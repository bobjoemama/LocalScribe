# LocalScribe macOS delivery plan

LocalScribe's active product and release scope is Apple Silicon macOS. This
plan separates implemented source behavior from evidence that still requires a
physical Mac and an exact packaged artifact.

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

If automatic updates remain disabled, document manual replacement behavior.
