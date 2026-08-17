# LocalScribe independent review packet for Claude Fable

## Mission

Perform an adversarial, evidence-gated review of LocalScribe’s source,
private GitHub repository, platform-specific inference paths, security
boundaries, model harness, UI behavior, packaging, and release claims.

Repository:

```text
https://github.com/bobjoemama/LocalScribe
```

The repository is private. Review `origin/main` only after fetching it, record
the exact commit with `git rev-parse origin/main`, and state that SHA in every
report. The repository has no hosted CI/CD pipeline; require fresh local command
evidence from the target platform.

This is a review request, not authorization to modify the repository, publish a
release, rotate credentials, install an app, download model weights, or change
GitHub settings. Remain read-only unless Devesh separately authorizes changes.

Use Opus 4.8 subagents where useful. Claude Fable must steer them, give each
agent a non-overlapping lane, require file-and-line evidence, reconcile
contradictions itself, and present one final verdict. Do not accept subagent
summaries without checking their cited evidence.

## Required proof language

Classify every finding as exactly one of:

- **Confirmed vulnerability**: a complete, evidence-backed exploit or security
  control failure is present in the reviewed commit.
- **Sensitive exposure**: secret or sensitive data is demonstrably exposed.
- **Plausible path**: the code permits a concerning path, but a prerequisite or
  exploit step remains unproved.
- **Correctness defect**: behavior contradicts a stated product contract but is
  not itself a security vulnerability.
- **Hardening opportunity**: a defensible control can be improved without a
  presently demonstrated failure.
- **Proof gap**: the claim cannot be established from source or available
  command/runtime evidence.
- **Not confirmed**: the review tested the suspected condition and did not
  establish it.

Never convert source evidence into runtime, GUI-smoke, physical-GPU,
clean-install, notarization, Authenticode, or user-ready proof. Do not say
“secure,” “safe,” “production-ready,” “cross-platform validated,” or “no
backdoor” without stating the exact evidence boundary.

## System under review

LocalScribe is a local-first Electron 43 desktop dictation application.
macOS arm64 and Windows x64 share the React/TypeScript renderer, settings,
encrypted SQLite text storage, audio contract, shortcut model, deterministic
text cleanup, insights, scratchpad, and insertion policy. Their inference and
native OS integrations differ:

| Area | macOS arm64 | Windows 11 x64 |
| --- | --- | --- |
| Speech engine | MLX Whisper 0.4.3 / MLX 0.32.0 | faster-whisper 1.2.1 / CTranslate2 4.8.1 CUDA |
| Python | CPython 3.12.13, relocatable arm64 runtime | CPython 3.12.13, relocatable x64 runtime |
| Accelerator memory | Apple unified memory reported by the worker | NVIDIA total/free VRAM via NVML |
| Target/paste helper | Swift Mach-O helper | MSVC Win32 helper |
| Distribution | DMG and ZIP | verified portable ZIP; no supported installer |
| Production trust | Developer ID, hardened runtime, notarization, stapling | public Windows release is fail-closed pending signing/installer acceptance |

The main process supervises one bounded NDJSON worker over stdin/stdout. There
is no transcription HTTP service, listener socket, account, or intended
telemetry path. Model weights are not in installers. The renderer cannot
directly access SQLite, workers, arbitrary filesystem paths, or native helpers.

High-level data flow:

```text
global shortcut
  -> main-process hotkey state machine
  -> sandboxed recorder
  -> bounded PCM16 mono 16 kHz WAV
  -> supervised platform worker
  -> local model
  -> deterministic text pipeline
  -> target-guarded native insertion or clipboard fallback
  -> encrypted text history / local insights
```

## Exact technology and dependency baseline

Treat the reviewed commit as the authority rather than trusting a copied
version list:

- Node.js: `.nvmrc`
- npm: `package.json` `packageManager`
- Electron 43.2.0
- React / React DOM 19.2.8
- TypeScript 5.9.3
- Vite 8.1.5
- Vitest 4.1.0
- better-sqlite3 13.0.1
- uiohook-napi 1.5.5
- uv: `.uv-version`
- Python 3.12.13
- MLX 0.32.0
- MLX Whisper 0.4.3
- MLX Audio 0.4.6
- faster-whisper 1.2.1
- CTranslate2 4.8.1
- CrispASR 0.8.24
- CUDA 12.9 user-space packages and cuDNN 9.25 on Windows

Review `package.json`, `package-lock.json`, all three `uv.lock` files,
dependency-script allowlists, overrides, audits, SBOM generators, and the
runtime builders. Confirm that the local first-party worker is force-rebuilt
rather than reused from a same-version uv wheel cache.

## Model harness contract

Parakeet Unified EN 0.6B is the default Mac family. Whisper large-v3, Qwen3-ASR 0.6B, Qwen3-ASR 1.7B, and
Whisper large-v2 are the curated-addable families. “Add model” means make an
already reviewed family from the packaged catalog available in the local
library; it does not select, load, or apply that family. It is intentionally not
an arbitrary repository, URL, manifest, plugin, Python module, or custom loader.

Reviewers should challenge that safety/usability choice, but must not describe
arbitrary model loading as implemented.

### macOS MLX artifacts

| Family | Mode | Precision | Exact download bytes | Estimated unified memory | Manifest license |
| --- | --- | --- | ---: | ---: | --- |
| large-v3 | High | FP16 | 3,083,520,685 | 4.0–5.5 GiB | MIT |
| large-v3 | Medium | 8-bit | 1,707,566,582 | 2.5–3.5 GiB | Undeclared |
| large-v3 | Low | 4-bit | 973,563,382 | 1.8–2.7 GiB | Undeclared |
| Qwen3-ASR 0.6B | High | BF16 | 1,569,438,434 | 2.0–3.0 GiB | Apache-2.0 |
| Qwen3-ASR 0.6B | Medium | 8-bit | 1,010,773,761 | 1.4–2.3 GiB | Apache-2.0 |
| Qwen3-ASR 0.6B | Low | 4-bit | 712,781,279 | 1.1–2.0 GiB | Apache-2.0 |
| Qwen3-ASR 1.7B | High | BF16 | 4,080,710,353 | 4.2–5.4 GiB | Apache-2.0 |
| Qwen3-ASR 1.7B | Medium | 8-bit | 2,467,859,030 | 2.6–3.6 GiB | Apache-2.0 |
| Qwen3-ASR 1.7B | Low | 4-bit | 1,607,633,106 | 1.8–2.8 GiB | Apache-2.0 |
| large-v2 | High | FP16 | 3,083,149,692 | 4.0–5.5 GiB | Undeclared |
| large-v2 | Medium | 8-bit | 1,707,195,589 | 2.5–3.5 GiB | Undeclared |
| large-v2 | Low | 4-bit | 973,192,389 | 1.8–2.7 GiB | Undeclared |

The five `Undeclared` entries are not represented as MIT. Public macOS
packaging must fail unless the local signed-build environment supplies
`LOCALSCRIBE_UNDECLARED_MLX_LICENSE_APPROVED=1`. That boolean is only a gate; it
is not itself a legal-review record.

### Windows faster-whisper artifacts

| Family | Physical artifact bytes | Mode | Compute type | Estimated VRAM | Manifest license |
| --- | ---: | --- | --- | ---: | --- |
| large-v3 | 3,090,835,702 | High | `float16` | 4.5–5.5 GiB | MIT |
| large-v3 | same artifact | Medium | `int8_float16` | 2.9–3.5 GiB | MIT |
| large-v3 | same artifact | Low | `int8` | 2.6–3.3 GiB | MIT |
| large-v2 | 3,089,578,858 | High | `float16` | 4.5–5.5 GiB | MIT |
| large-v2 | same artifact | Medium | `int8_float16` | 2.9–3.5 GiB | MIT |
| large-v2 | same artifact | Low | `int8` | 2.6–3.3 GiB | MIT |

### Windows Qwen3-ASR artifacts

| Family | Mode | GGUF precision | Exact download bytes | Estimated VRAM | Manifest license |
| --- | --- | --- | ---: | ---: | --- |
| Qwen3-ASR 0.6B | High | F16 | 1,882,037,824 | 2.5–3.5 GiB | Apache-2.0 |
| Qwen3-ASR 0.6B | Medium | Q8_0 | 1,006,809,760 | 1.6–2.6 GiB | Apache-2.0 |
| Qwen3-ASR 0.6B | Low | Q4_K | 631,026,336 | 1.2–2.2 GiB | Apache-2.0 |
| Qwen3-ASR 1.7B | High | F16 | 4,704,800,576 | 4.8–5.8 GiB | Apache-2.0 |
| Qwen3-ASR 1.7B | Medium | Q8_0 | 2,506,723,200 | 2.6–3.6 GiB | Apache-2.0 |
| Qwen3-ASR 1.7B | Low | Q4_K | 1,490,915,200 | 1.8–2.8 GiB | Apache-2.0 |

Review the CrispASR C ABI lifetime, CUDA-only fail-closed behavior, selected
GPU isolation, exact native-file inventory, archive and per-file SHA-256 gates,
license/notice retention, SBOM component, and the absence of cross-family or
CPU fallback.

The Mac modes use distinct physical quantized artifacts. The Windows modes use
one physical CTranslate2 artifact per family with three allowlisted compute
profiles. Verify that UI text, install state, storage accounting, worker
requests, and manifest identity preserve that distinction.

### Auto policy

Auto is policy, not a model and not a fallback chain. It:

- samples live total/currently free accelerator memory at each recording
  boundary; while a model is warm, its conservative minimum allocation is
  added back for selection policy, capped at physical memory, so the active
  tier does not count against itself;
- evaluates each tier against its conservative maximum estimate;
- requires an additional 1 GiB before upgrading;
- downgrades immediately if the current tier no longer fits;
- pins the resolved tier during active dictation;
- resolves to Low with an explicit insufficient/unknown-memory condition when
  diagnostics cannot establish a fit.

Every mode reserves the greater of 2 GiB or 20% of total memory above the
model's maximum estimate. Explicit High, Medium, or Low fail closed when that
exact tier does not fit and must not silently change tier or family. Confirm
there is no hidden Whisper.cpp, CPU, cloud, alternate-family, or cross-engine
fallback.

### Model installation and loading

Review the complete transaction:

1. Renderer requests an install only through validated IPC.
2. Main selects one catalog entry for the actual platform.
3. Worker receives fixed model ID, revision, artifact identity, storage name,
   and `allowDownload: true`.
4. Download goes to a staging directory.
5. Symlinks, unexpected files, unsafe paths, wrong sizes, and wrong SHA-256
   digests are rejected.
6. Activation is atomic only after every file verifies.
7. Normal model load always uses `allowDownload: false` /
   `local_files_only=True`.
8. Dictation reports a missing model rather than downloading implicitly.

Selection and installation are separate transactions. Family/tier changes are
pending renderer state until one **Apply model** request carries both values.
Apply must serialize against dictation and install/remove work, verify the exact
target artifact, stop and fully release the previous worker/model, preload the
target with downloads disabled, and only then persist the family and mode
together. Review rollback for target-load failure and database-commit failure;
the UI must not label the candidate active before model-ready acknowledgement.
No implementation may keep both old and new model runtimes intentionally
resident during a switch.

Look for disk-exhaustion paths, interrupted installs, staging cleanup errors,
manifest substitution, family/tier aliasing, TOCTOU, unsafe archive behavior,
Hugging Face token leakage, proxy/network surprises, and reparse-point issues.

## Shortcut contract

The two shortcuts are independent settings:

- push-to-talk: hold a recorded key or key combination, speak, release;
- toggle dictation: press once to start and once to stop.

The recorder is not a dropdown. It captures the actual key/chord, canonicalizes
aliases, detects collisions with the other LocalScribe shortcut, and attempts
OS registration for registerable accelerators. Modifier-only global collision
preflight is not generally available from macOS or other apps; the UI must not
claim otherwise.

Review these specific regressions:

- changing away from Control must deactivate the old Control hold behavior;
- pill, homepage, history, tooltips, help, and settings must render the saved
  shortcut rather than a hard-coded Control label;
- a failed registration/persistence transaction must roll back runtime state
  and UI state atomically;
- AltGr / Right Alt must not be mis-recorded as Control+Alt;
- extra modifier keys, non-modifier keys, or mouse events during a hold chord
  must cancel the gesture rather than trigger it;
- toggle mode may show cancel/accept controls, while hold-to-talk should show
  only the live pill/wave state;
- loading and persistence failures must not briefly display a false default.

Trace:

- `src/shared/shortcuts.ts`
- `src/main/hotkeys/`
- `src/main/settings/settingsTransaction.ts`
- shortcut IPC in `src/main.ts` and `src/preload.ts`
- `src/renderer/settings/components/ShortcutRecorder.tsx`
- every renderer presentation of shortcuts

## UI and product behavior review

Do not reduce this lane to snapshots. Review both implementation and an
interactive packaged smoke when suitable hardware is available.

### Pill

Verify:

- inactive pill is small, black, rounded, minimally translucent, with a subtle
  light border;
- it follows the active display and sits near the lower center;
- hover expands without clipping and exposes dictation/scratchpad affordances;
- hovered scratchpad and microphone affordances change the label correctly;
- live audio bars respond to measured microphone levels rather than a canned
  loop;
- push-to-talk and toggle states have intentionally different controls;
- readable transient errors expand outside the pill, auto-dismiss, show a
  countdown/progress affordance, and remain manually dismissible;
- the pill cannot get stuck indefinitely in an error state;
- microphone selection changes the actual input device.

### Scratchpad

Verify:

- opening from the pill creates or reveals the persistent scratchpad window;
- clicking another app does not destroy or hide the window unexpectedly;
- closing the window hides it without terminating LocalScribe;
- “New draft” appends a separately persisted draft instead of replacing one;
- draft selection, editing, saving, search, word counts, and copy work;
- disabled LLM-only tools are visibly unavailable and say that an additional
  local model is required;
- layout remains usable at default and increased text size.

### Main settings and insights

Verify:

- all navigation, toggles, selectors, permission indicators, close behavior,
  and saved settings are functional rather than visual filler;
- Accessibility status refreshes after the user grants it;
- auto-paste inserts into the captured editable target;
- clipboard fallback occurs when no editable target exists, focus changes, or
  insertion fails;
- dictionary entries affect the actual local text pipeline;
- deterministic cleanup, snippets, literal commands, and supported styles work
  as documented;
- generative rewrite/transform controls are disabled when no additional local
  LLM is configured and do not pretend to run;
- daily insight bars expose exact date and word count on hover;
- app/category usage derives from captured application identity rather than
  placeholder values;
- charts, periods, labels, and settings remain readable and keyboard
  accessible.

List every screen or control that is still placeholder-only.

## Electron and IPC security lane

Review:

- `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`;
- navigation/window-open denial;
- strict renderer CSP and custom protocol behavior;
- preload API minimization;
- IPC sender/frame validation;
- Zod schemas, maximum sizes, strict-object handling, and error redaction;
- Electron fuses for RunAsNode, `NODE_OPTIONS`, CLI inspection,
  `file://` privileges, cookie encryption, and ASAR integrity;
- absence of remote module, shell execution from renderer input, `eval`,
  unsafe `child_process` construction, arbitrary URLs, arbitrary filesystem
  access, or untrusted deserialization;
- production source-map behavior;
- development-only behavior that could accidentally enter production.

Search for:

```sh
rg -n "shell:|exec\\(|execFile|spawn\\(|eval\\(|new Function|openExternal|loadURL|setWindowOpenHandler|ipcMain|contextBridge|webSecurity|allowRunningInsecureContent|nodeIntegration|sandbox|contextIsolation" src forge.config.ts
```

Every subprocess argument derived from renderer, database, model manifest, or
environment state needs a separate trust-boundary assessment.

## Native insertion and focus lane

The intended guarantee is:

- main captures an active target before dictation;
- transcript never appears in command-line arguments;
- main places text in the clipboard;
- native helper receives only validated target identity/fingerprint metadata;
- helper recaptures the active target immediately before injection;
- mismatched PID, app identity, window fingerprint, or editability fails
  closed;
- missing helper or failed validation becomes clipboard-only;
- no uiohook synthetic-paste bypass remains.

Review both:

- `resources/native/macos/active-target.swift`
- `resources/native/windows/active-target.cpp`
- `src/main/insertion/`

Explicitly state the residual micro-race between the final native target check
and OS event delivery. Determine whether any stronger platform primitive is
practical. Test hostile focus switching where possible.

## Audio and worker lane

Review the shared contract in `resources/audio-protocol.json`,
`src/shared/audioProtocol.ts`, both Python workers, and both test suites.

Required boundary:

- mono;
- 16 kHz;
- signed PCM16;
- bounded byte count, duration, frames, and path length;
- temporary file under a main-process-owned permitted root;
- deletion in a `finally` path;
- main-to-worker requests capped at 16 KiB and worker-to-main response lines
  capped at 1 MiB, which covers the bounded 100,000-character result under
  worst-case JSON escaping;
- stdout protocol-only, stderr diagnostic-only;
- no arbitrary media/container parsing from renderer-controlled input.

Windows must reject symlink/reparse components, open the WAV once, validate
file identity and size before/after bounded reading, and transcribe an immutable
in-memory snapshot. Review whether file identity is sufficiently strong on
NTFS and network/reparse edge cases.

macOS should receive equivalently bounded PCM and must not reopen an
attacker-substitutable path. Review microphone selection, permission denial,
zero-length recordings, device disconnects, cancellation, and worker restart.

## Persistence and privacy lane

Review:

- migrations and downgrade/partial-migration behavior;
- WAL, foreign keys, busy timeout, transaction boundaries, and corruption
  recovery;
- OS-keystore key creation, retrieval, denial, rotation, and fallback;
- encryption/authentication of transcripts, snippets, profiles, and scratchpad
  text;
- which dictionary, settings, application identity, category, timing, and
  insight fields remain plaintext metadata;
- POSIX database parent `0700` and DB/WAL/SHM `0600` best-effort hardening;
- Windows ACL behavior;
- logs, crash output, clipboard lifetime, temporary audio, keychain prompts,
  and error messages;
- deletion semantics and whether user-visible “local and encrypted” wording is
  precise.

Do not call the database fully encrypted if metadata remains plaintext.

## External resource and package integrity lane

The package contains runtime resources outside `app.asar`. Review the complete
control:

- deterministic SHA-256 Merkle root over the platform-pruned worker, Python
  runtime, native helper, manifests, and required branding;
- generated expectation embedded into `app.asar`;
- source placeholder restored after packaging and on process exit;
- verification before signing and after final package creation;
- startup verification before protocol, catalog, or worker construction;
- rejection of extra, missing, changed, unsupported, oversized, broken, or
  escaping-symlink entries;
- cross-platform resource exclusion;
- target-only pruning and validation for unpacked native Node binaries;
- macOS pre-signing of protected Mach-O resources before the expected root is
  generated, preservation during outer app signing, and final deep signature
  verification;
- Electron fuses `EnableEmbeddedAsarIntegrityValidation` and
  `OnlyLoadAppFromAsar`.

Check that the macOS solution does not weaken nested-code signing or
notarization. On Windows, confirm what Forge/AuthentiCode mutates and that the
precomputed root still matches the final packaged runtime.

Package inventory must reject tests, caches, bytecode, source maps, lock/build
files, environment/credential-like files, private keys, opposite-platform
resources, unapproved manifests, development Node modules, and the supported
model weight names (`weights.npz`, `model.bin`, `model.safetensors`). Treat the
filename-based no-weight rule as bounded to supported model formats rather than
a proof against every future filename.

## Supply chain and local release lane

Review:

- absence of hosted workflow files and paid CI/CD dependencies;
- exact Node, npm, uv, CPython, npm lock, uv locks, and audit-tool lock;
- exact Node/npm/uv pin resolution and fail-closed version verification;
- `npm ci --strict-allow-scripts` and exact dependency-script allowlist;
- production and full npm audits;
- Python lock export and `pip-audit` with dependency resolution disabled;
- deterministic platform core-runtime SBOM;
- locked platform Python SBOM;
- checksums with paths relative to `out/`;
- local installer/SBOM output names and retention;
- package tests against bundled Python after runtime assembly;
- public-release fail-closed checks when credentials are absent;
- source tag/version/commit binding in the manual release record;
- secret exposure limited to the local signed-build process;
- macOS Developer ID/notary/stapler checks;
- Windows Authenticode/timestamp checks.

The core-runtime SBOM should contain the 11 production npm graph components
plus Electron, CPython, and the correct first-party helper: 14 components total
for each platform at the current lock. The Python SBOMs currently contain 55
macOS components and 29 Windows components. Recompute these numbers.

Inspect GitHub itself after the final push:

- repository is private;
- `origin/main` matches the locally verified SHA;
- no GitHub Actions workflow files are present;
- branch protection requires pull requests, conversation resolution, and
  linear history without hosted status checks;
- locally generated artifact names match the documented procedure;
- `SHA256SUMS.txt` verifies against the local artifact directory;
- SBOM JSON parses and matches the platform;
- no secrets appear in source or captured local verification output;
- branch protection and secret custody are reported only if actually
  observable.

Do not create a tag, publish a release, or request signing credentials merely
to review the repository.

## Performance and platform-optimization lane

### macOS

Assess:

- MLX model load/inference behavior on Apple Silicon;
- peak unified memory, resident memory, model-load time, first-token/final
  latency, real-time factor, thermals, and memory release;
- FP16 vs 8-bit vs 4-bit accuracy and performance;
- Auto decisions under memory pressure;
- whether Torch/SciPy and other runtime contents are genuinely needed by
  MLX Whisper;
- runtime and installer size reductions that do not weaken supportability;
- M4 Max 48 GiB behavior and a lower supported Apple Silicon tier.

Existing evidence is narrow: on July 24, 2026, the final packaged Python worker
runtime loaded large-v3 FP16 on this Apple Silicon machine in about 3.7 seconds
and transcribed one generated utterance in about 0.5 seconds. That is a direct
packaged-worker smoke, not end-to-end GUI dictation, multi-tier, accuracy,
microphone, or sustained-use proof. Reproduce before citing it.

### Windows

Assess:

- actual CUDA/cuDNN/CTranslate2 compatibility;
- NVIDIA driver minimums;
- peak VRAM and RAM for all three profiles;
- model load and real-time factor;
- GPU capability failures;
- NVML absence/permission behavior;
- Auto under competing VRAM load;
- portable extraction, hidden login startup, and manual replacement;
- future installer clean install/update/uninstall;
- at least the claimed minimum GPU and one current RTX generation.

A Windows portable package built without real NVIDIA inference is not Windows
CUDA model validation. Squirrel must not be treated as a viable installer:
its 32-bit payload embedder silently produced a dummy Setup.exe for the
1.588 GB package. Review the portable exact-copy gate and the legacy
fail-closed payload regression separately.

### Accuracy

Create or use a disclosed dictation corpus with:

- quiet conversational English;
- fast speech and corrections;
- punctuation commands;
- names and dictionary terms;
- code/technical vocabulary;
- accented English;
- background noise;
- long-form dictation;
- at least the supported non-English languages.

Report WER/CER and task-level dictation success separately. Compare large-v3
FP16, 8-bit, and 4-bit on Mac and `float16`, `int8_float16`, and `int8` on
Windows. If large-v2 is compared, use the same corpus and disclose decoding
settings. Do not import vendor leaderboard claims as product-level proof.

## Minimum command evidence

Run from a fresh clone or clean worktree at the reviewed SHA:

```sh
git status --short
git rev-parse HEAD
git rev-parse origin/main
npm run toolchain:verify
npm ci --strict-allow-scripts
npm run verify:local
git diff --check
git status --short
```

On Apple Silicon:

```sh
npm run verify:local:macos
npm run verify:local:macos -- \
  --smoke-model-root "$HOME/Library/Application Support/LocalScribe/models" \
  --smoke-audio /absolute/path/to/fixture.wav \
  --smoke-family qwen3-asr-0-6b --smoke-tier medium --smoke-mode after-stop --smoke-repeat 2
```

Do not run packaged Python without `-B` /
`PYTHONDONTWRITEBYTECODE=1` inside a signed app: new bytecode files mutate the
sealed bundle and invalidate that local unpacked copy.

On Windows x64:

```powershell
npm run verify:local:windows
npm run verify:local:windows -- -RequireCuda
npm run verify:local:windows -- -RequireCuda `
  -CudaModelRoot "$env:APPDATA\LocalScribe\models" `
  -CudaFamily qwen3-asr-0-6b -CudaTier medium -CudaRepeat 2
Get-AuthenticodeSignature <signed-artifact>
```

Only run the Authenticode command against an artifact that is claimed to be a
signed release candidate. An unsigned local validation artifact should be
reported as unsigned.

## Known evidence boundaries to preserve

At handoff, none of these should be rounded up:

1. A physical RTX 3060 Laptop validation established CUDA device discovery,
   current/free VRAM telemetry, CTranslate2/faster-whisper imports, and all
   three advertised compute profiles. It did not establish model load,
   inference, peak VRAM, microphone, hotkey/paste, manual update, or any
   installer lifecycle.
2. No production Developer ID/notarized/stapled artifact or timestamped
   Authenticode artifact has been established.
3. The five `Undeclared` MLX model revisions require real legal review. A
   local environment-variable gate is not the review itself.
4. Not every model family/tier has completed real inference or accuracy
   testing. Existing Mac evidence is one direct packaged-worker FP16 smoke.
5. Local validation DMGs may carry Apple Development or ad-hoc signatures and
   are not public release artifacts.
6. SQLite sensitive text is encrypted, but some settings, dictionary,
   application/category, and insight metadata remains plaintext under
   user-only filesystem permissions.
7. Native target validation leaves an irreducible micro-race immediately
   before OS event delivery.
8. The package weight exclusion recognizes supported model filenames, not
   every arbitrary future weight filename.
9. GitHub branch protection, secret custody, and legal-variable provenance
   cannot be inferred from source files.
10. Visual similarity to another app is not functional or accessibility proof.

## Suggested Opus 4.8 subagent lanes

Claude Fable may adjust the decomposition, but should avoid overlap:

1. Shortcut runtime, recorder, persistence, rollback, and all UI presentation.
2. Model catalog, manifests, install/load transactions, Auto policy, and
   platform separation.
3. macOS MLX worker, memory behavior, native helper, signing, and DMG.
4. Windows CUDA worker, WAV snapshot, native helper, portable ZIP, legacy
   Squirrel failure gate, and future Authenticode design.
5. Electron renderer/IPC/CSP/fuses/navigation and subprocess boundaries.
6. SQLite, keychain/credential manager, privacy, filesystem permissions, temp
   audio, clipboard, and logging.
7. Resource Merkle integrity, package inventory, ASAR, first-party worker
   cache freshness, and artifact inspection.
8. npm/Python supply chain, SBOM completeness, local verification, checksums,
   and GitHub branch inspection.
9. Pill, scratchpad, settings, insights, dictionary, snippets, cleanup,
   transforms, accessibility, and functional UI smoke.
10. Cross-platform performance, VRAM/unified-memory estimates, real-device
    benchmark design, accuracy, and support matrix.

Each agent should return:

- reviewed SHA;
- files and line numbers;
- commands and exact outcomes;
- findings using the required classifications;
- proof gaps;
- proposed minimal fix and regression test for every actionable finding.

## Required final report

Claude Fable’s final response should include:

1. **Executive verdict** bounded to the reviewed SHA and evidence tier.
2. **Stop-ship table** ordered by severity.
3. **All findings table** with classification, severity, component, exact
   file:line, preconditions, impact, minimal fix, and required retest.
4. **Backdoor/exfiltration assessment** separating confirmed code paths,
   plausible paths, and not-confirmed suspicions.
5. **Shortcut verdict** including old-Control deactivation and dynamic UI.
6. **Model harness verdict** for platform separation, curated addition,
   installation integrity, and Auto/no-fallback behavior.
7. **Feature matrix** marking each visible feature functional, disabled with
   truthful explanation, placeholder, or untested.
8. **macOS verdict** separating source, packaged validation, signed/notarized,
   and physical-model evidence.
9. **Windows verdict** separating source, local package, signed installer, and
   physical-NVIDIA evidence.
10. **Supply-chain and GitHub verdict** including the verified source SHA,
    local command evidence, and artifact checksum results.
11. **Performance/accuracy plan** for all tiers without treating estimates as
    measurements.
12. **Residual-risk register** with owners and acceptance decisions.
13. **Exact go/no-go checklist** for personal Mac use, personal Windows use,
    private beta, and public distribution.

If no confirmed backdoor, RCE, or exfiltration is found, say:

> No confirmed backdoor, remote-code-execution path, or intentional
> exfiltration path was established in the reviewed commit under the tests
> performed.

Do not shorten that to “there is no backdoor.” Absence of a finding is not a
proof over all runtime dependencies, signing infrastructure, operating-system
behavior, or future commits.
