# LocalScribe delivery plan

## 1. Cross-platform local inference

Source implementation:

- Apple Silicon: fixed MLX Whisper engine, with default large-v3 and curated
  addable large-v2 FP16, 8-bit, and 4-bit artifacts
- Windows x64 NVIDIA: fixed faster-whisper/CTranslate2 CUDA engine, with one
  shared artifact per family—default large-v3 and curated addable large-v2—and
  `float16`, `int8_float16`, and `int8` profiles
- exactly Auto, High, Medium, and Low user modes
- deterministic, main-owned Auto resolution with worker-side allowlist checks
- revision-, size-, and SHA-256-pinned model installation
- no implicit model download during dictation
- no plugins, arbitrary URLs/code, or custom model loaders

Whisper large-v3 remains the default family; large-v2 is curated and can be
added locally. Model weights are not bundled. Turbo is not enabled: enabling it
requires a complete, validated three-tier Mac contract, including pinned MLX
artifacts, installation verification, resource evidence, and real-device
coverage. See [MODEL_CATALOG.md](MODEL_CATALOG.md).

Remaining product evidence: real accuracy/latency/memory benchmarks for every
supported family, all Mac tiers, and all Windows compute profiles.

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
  graph, Electron, CPython, and native helper) and locked platform Python
  dependencies, with SBOM and artifact SHA-256 generation in CI

The generated Mac Python runtime and Windows Python/CUDA runtime are ignored by
Git. CI and release builds must recreate them from committed locks.

## 4. macOS distribution

Validation path:

- `npm run make:mac`
- Apple Development or ad-hoc signature
- strict code-signature verification
- unsigned validation DMG/ZIP

Production path:

- manual `release` environment restricted to version tags
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

- locked faster-whisper runtime build on `windows-latest`
- hardened x64 helper build and deterministic smoke
- native Node rebuild, worker tests, and Squirrel make
- clearly named unsigned validation Setup.exe

Production path:

- manual `release` environment restricted to version tags
- Authenticode certificate or managed signing parameters
- required HTTPS timestamp server
- signatures on app, helper, and Squirrel installer

Remaining release QA requires a physical NVIDIA system: packaged model install,
real audio transcription for all profiles, VRAM/latency/accuracy measurement,
hotkey/paste/permission matrix, clean install/update/uninstall, and SmartScreen
behavior.

## 6. Publication

The repository does not automatically create a public GitHub Release or update
feed. Signed workflow artifacts remain release candidates until reviewed.

Before publication:

1. match source tag, package version, model manifests, both platform-specific
   SBOMs, and checksums;
2. complete platform signing/notarization checks;
3. scan the exact artifacts;
4. complete clean-machine and real-hardware QA;
5. design and verify a separately signed update feed, or ship with updates
   disabled and document manual upgrade behavior.
