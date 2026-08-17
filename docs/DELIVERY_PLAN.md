# LocalScribe delivery plan

## 1. Cross-platform local inference

Source implementation:

- Apple Silicon: FluidAudio/Core ML/ANE Parakeet Unified EN 0.6B is the
  fresh-install default, with curated High FP16 and Medium INT8 artifacts for
  after-stop and live English dictation; MLX Whisper large-v3 and large-v2 plus
  MLX Audio Qwen3-ASR 0.6B and 1.7B remain curated after-stop alternatives
- Windows x64 NVIDIA: faster-whisper/CTranslate2 CUDA for the two Whisper
  families and CrispASR/GGML CUDA for Qwen3-ASR 0.6B and 1.7B
- exactly Auto, High, Medium, and Low user modes
- deterministic, main-owned Auto resolution with worker-side allowlist checks
- revision-, size-, and SHA-256-pinned model installation
- no implicit model download during dictation
- no plugins, arbitrary URLs/code, or custom model loaders

Parakeet Unified EN 0.6B is the default Mac family; Whisper large-v3,
Qwen3-ASR 0.6B, Qwen3-ASR 1.7B, and large-v2 are curated and can be added
locally. Qwen3-ASR 0.6B is the smaller lower-latency candidate, but it is not
represented as faster until the same workload is measured on the target Mac and
NVIDIA Windows systems. Model weights are not bundled. Turbo is not
enabled: enabling it requires a complete, validated three-tier Mac contract,
including pinned MLX artifacts, installation verification, resource evidence,
and real-device coverage. See [MODEL_CATALOG.md](MODEL_CATALOG.md).

Remaining product evidence: real accuracy/latency/memory benchmarks for every
supported family, all Mac tiers, and all Windows compute profiles.

Model selection is an explicit transaction. Family and performance choices
remain pending until **Apply model** is pressed. Apply verifies the exact
curated target, unloads the previous runtime, preloads the target without an
implicit download, and commits the new family/tier only after the target reports
ready. A failed apply must preserve the prior committed selection and report
the rollback state instead of claiming the candidate is active.

## 2. Desktop workflow

Implemented and source-tested:

- floating dictation pill and settings
- 16 kHz mono PCM16 AudioWorklet capture
- push-to-talk and toggle shortcuts
- target-guarded paste with copy-only fallback
- history, dictionary, snippets, app profiles, deterministic text cleanup, and
  scratchpad
- SQLite persistence with OS-keystore encryption for transcript text, snippet
  expansions, and scratchpad bodies; operational metadata and dictionary rules
  remain plaintext inside permission-restricted database files
- platform permission/status surfaces

Remaining GUI evidence: fresh-user microphone flow, global shortcut behavior,
paste matrix, tray/menu, login item, multi-monitor/DPI, and failure recovery on
both operating systems.

## 3. Package integrity

Implemented:

- platform-specific worker/runtime/helper/model allowlists
- whole-app ASAR, native-module, and extra-resource inventory
- rejection of opposite-OS resources, tests, source maps, caches, lock/build
  files, environment/secrets, unexpected model manifests, and escaping symlinks
- release sourcemaps disabled
- compatible patched npm overrides; production and full build-tool audits
- separate CycloneDX SBOMs for each platform core runtime (production Node
  graph, Electron, CPython, native helper, and Windows CrispASR runtime) and
  locked platform Python dependencies, with local SBOM and artifact SHA-256
  generation

The generated Mac Python runtime and Windows Python/CUDA runtime are ignored by
Git. Local verification and release builds must recreate them from committed
locks.

## 4. macOS distribution

Validation path:

- `npm run verify:local:macos`
- Apple Development or ad-hoc signature
- strict code-signature verification
- local validation DMG/ZIP, SBOMs, and verified checksums

Production path:

- explicit local `LOCALSCRIBE_RELEASE=1 npm run make:mac`
- Developer ID Application identity only
- hardened runtime and narrow per-helper entitlements
- app notarization/stapling, DMG signing/notarization/stapling
- `codesign`, `stapler`, and Gatekeeper assessment

Missing credentials fail before packaging. Validation artifacts are not
production artifacts.

Remaining release QA: clean-machine install, first-launch permissions, model
download, offline dictation, update/uninstall policy, and signed artifact review.

## 5. Windows distribution

Validation path:

- locked faster-whisper and CrispASR runtime build on a local Windows 11 x64 machine
- hardened x64 helper build and deterministic smoke
- native Node rebuild with target-only binary pruning, worker/CUDA checks, and
  portable ZIP make
- packaged startup, exact ZIP-to-staged-tree comparison, SBOM, checksum, and
  complete PE-signature-state checks
- locally reviewed unsigned portable validation ZIP

Production path:

- currently blocked fail-closed in `LOCALSCRIBE_RELEASE=1` mode
- select a supported installer that can carry or securely acquire the large
  pinned CUDA runtime
- passwordless managed Authenticode signing with an exact signer/timestamp
  acceptance policy
- separately designed and tested update/uninstall path

Remaining release QA requires a physical NVIDIA system: packaged model install,
real audio transcription for all profiles, VRAM/latency/accuracy measurement,
hotkey/paste/permission matrix, portable extraction/manual replacement, and
SmartScreen behavior. Clean install/update/uninstall applies to the future
installer deliverable, not the current portable ZIP.

## 6. Publication

The repository does not automatically create a public GitHub Release or update
feed. Locally signed artifacts remain release candidates until reviewed.

Before publication:

1. match source tag, package version, model manifests, both platform-specific
   SBOMs, and checksums;
2. complete platform signing/notarization checks;
3. scan the exact artifacts;
4. complete clean-machine and real-hardware QA;
5. design and verify a separately signed update feed, or ship with updates
   disabled and document manual upgrade behavior.
