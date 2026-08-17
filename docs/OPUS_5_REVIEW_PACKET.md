# LocalScribe Opus 5 review, refactor, and bug-fix packet

Copy everything below the divider into a fresh Opus 5 coding session that has
access to the LocalScribe checkout. This is an implementation assignment, not
a request for a high-level review.

---

You are the lead engineer responsible for an adversarial review, careful
refactor, and bug-fix pass over **LocalScribe**. Use Opus 5 subagents for bounded
independent lanes if your environment supports them, but keep one lead agent
responsible for integration, conflict resolution, and the final evidence. Do
not let multiple agents edit the same files concurrently.

Repository and target:

- Repository: `bobjoemama/LocalScribe`
- Working branch: `feature/qwen3-asr`
- Begin from the latest remote commit and record the full commit SHA.
- Primary runtime to validate locally: macOS Apple Silicon.
- Secondary runtime: Windows x64 with NVIDIA CUDA. Do not claim physical
  Windows behavior from source simulation or macOS-only tests.

## Mission

Review the entire application, reproduce defects where possible, implement the
smallest durable fixes, refactor code only where the refactor reduces a proven
risk, and leave the repository cleaner and more thoroughly verified than you
found it.

The standard is not "the tests passed." The standard is that the tests cover
the failure modes users actually encounter: clipped or unreachable controls,
unstable hover behavior, stale UI state, controls that appear functional but do
nothing, incorrect model lifecycle claims, unsafe IPC or filesystem behavior,
and platform code that was only tested on the other operating system.

Do not weaken, delete, skip, or rewrite a failing check merely to make a gate
green. When a check is wrong, first prove why it is wrong, replace it with a
stronger check, and preserve the original failure mode as a regression case.

## Product invariants

Preserve all of these unless you can demonstrate a defect and explain the
replacement before changing it:

1. Speech recognition and user data stay local. No cloud fallback, telemetry,
   remote prompt, or hidden network path may be added.
2. Model downloads are explicit user actions. Inference never downloads.
3. Only curated models with pinned revisions, exact file inventories, byte
   counts, and SHA-256 digests are accepted. Arbitrary loaders, URLs, paths, and
   model code are rejected.
4. Selecting a model family or tier only creates renderer-local pending state.
   The running model does not change until the user presses **Apply model**.
5. Apply must validate the target, unload the old model, load and acknowledge
   the exact target, then persist the new routing choice. Never overlap two
   large model runtimes. Failure must preserve or restore the prior committed
   selection.
6. A warm model stays warm between dictations. Diagnostics, unrelated model
   downloads, and unrelated removals must not evict it.
7. Auto mode may select a tier only within the user-selected family. It must
   use live platform memory information without silently falling back to a
   different model family.
8. macOS uses MLX/Metal-capable runtimes. Windows uses NVIDIA CUDA runtimes.
   Shared UI may be shared; backend facts, artifacts, memory terminology, and
   runtime checks must remain platform-correct.
9. Closing a normal window hides or closes that window without killing the
   resident dictation service. Explicitly quitting the app must terminate its
   worker and temporary resources.
10. Audio is discarded after transcription. Transcript history and scratchpad
    data remain local and protected according to the documented persistence
    contract.

## UI and interaction invariants

Treat these as release blockers:

- The native arrow cursor must remain stable over application controls. Do not
  alternate between arrow, hand, busy, and forbidden cursors as hover-expanded
  hit targets move. Editable text fields may use the I-beam.
- The pill must not change cursor shape while expanding, contracting, opening
  the microphone picker, recording, processing, succeeding, or displaying an
  error.
- Hover animations must not move a hit target out from underneath a stationary
  pointer and oscillate between states.
- Every settings category must scroll independently between a fixed header and
  fixed footer at 1220x760 and 900x640. The sidebar category list must also
  remain reachable at short heights.
- Every model family, tier, install/repair/remove action, and Apply control must
  be reachable by mouse, trackpad, keyboard, and scrolling. No action may sit
  behind a footer or outside a clipped container.
- The scratchpad must remain usable at its smallest supported size: drafts,
  search, note list, editor, copy, close, collapse, and unavailable-feature
  explanations must remain reachable.
- Controls must accurately describe their state. A model is not "loaded" until
  the backend acknowledges it. A setting is not "saved" until persistence
  succeeds. Disabled features must explain why they are unavailable.
- Error messages must be readable, dismissible, transient where appropriate,
  and owned by one UI surface. Do not trap important errors inside the tiny
  collapsed pill.
- Keyboard shortcuts, microphone names, model names, device names, memory
  values, current platform, and effective settings must come from runtime state
  rather than duplicated UI literals.
- User-selected shortcuts must replace the previous runtime binding everywhere:
  implementation, pill copy, home-page copy, menu copy, and settings copy.
- Automatic paste must paste only into the still-valid target; otherwise it
  must copy to the clipboard and explain the fallback without losing text.

## Required review lanes

You may parallelize these as independent read-only audits first. The lead agent
must reconcile the findings before edits begin.

### 1. Renderer and UX

Inspect every renderer component and stylesheet, including the main history
window, settings, pill, notices, microphone picker, insights, dictionary,
snippets, style, transforms, notes, and scratchpad.

Look specifically for:

- conflicting cursor declarations;
- hover geometry that changes the element under the pointer;
- content hidden by `overflow: hidden` without a nested scroll owner;
- grid/flex children missing `min-height: 0` or `min-width: 0`;
- fixed heights that cannot survive smaller windows or larger text;
- controls reachable visually but not by keyboard;
- focus trapped behind portals, popovers, or fixed footers;
- stale renderer drafts overwritten by incoming backend broadcasts;
- async controls that can be clicked twice or report success too early;
- React keys, effects, timers, and subscriptions with incorrect lifetimes;
- hard-coded shortcuts, platform labels, devices, models, tiers, memory, or
  feature availability;
- visually present filler that has no backend behavior.

Exercise at least 1220x760 and 900x640. Also inspect large text, long device
names, long shortcut names, missing/invalid/verified model artifacts, failed
Apply, empty history, many history items, many drafts, and disconnected saved
microphones.

### 2. Electron main process and lifecycle

Review window ownership, tray behavior, single-instance behavior, quit versus
close, shortcuts, recording state, timers, display changes, microphone changes,
permissions, insertion, clipboard fallback, and worker lifecycle.

Prove:

- no two ASR workers/models overlap during a switch;
- quit cannot hang behind an in-flight worker operation;
- an unresponsive worker is terminated with a bounded graceful-to-forceful
  escalation and cannot remain orphaned;
- close-window behavior does not accidentally quit the resident service;
- repeated diagnostics do not unload a warm model;
- model install, repair, removal, Apply, recording, and shutdown operations are
  serialized where necessary without deadlocks;
- rollback never starts a model while the app is quitting;
- timers, global hooks, and display listeners are released on quit;
- no renderer can invoke privileged IPC outside its authorized surface.

### 3. Model catalog and native workers

Audit all curated families, tiers, manifests, platform allowlists, memory
estimates, executable runtime allowlists, and Python/native worker dispatch.

Current intended families are:

- Whisper large-v3
- Qwen3-ASR 0.6B
- Qwen3-ASR 1.7B
- Whisper large-v2

macOS Qwen uses MLX Audio. Windows Qwen uses CrispASR CUDA. macOS Whisper uses
MLX Whisper. Windows Whisper uses faster-whisper/CTranslate2. Confirm these
facts from source and packaged resources rather than trusting this packet.

Verify exact model identity through the full path: catalog -> selected profile
-> verified manifest -> worker request -> native loader -> acknowledged model.
No name-only or tier-only collision may route to another family.

### 4. Persistence and data integrity

Review SQLite transactions, schema evolution, encrypted transcript and
scratchpad storage, keychain behavior, retention deletion, draft creation,
concurrent settings updates, and recovery after interruption.

Prove that:

- creating a draft never overwrites an unrelated draft;
- settings Apply does not discard concurrent unrelated setting updates;
- failed model Apply does not persist candidate routing;
- deletion targets are exact and bounded;
- a live SQLite inspection includes WAL/SHM state or occurs after clean close;
- no secrets, transcripts, raw audio, downloaded weights, or temporary user
  data can enter Git or release artifacts unintentionally.

### 5. Security and supply chain

Audit preload exposure, IPC schemas and authorization, command construction,
path traversal, symlinks/reparse points, archives, downloads, redirects,
digest-before-use, atomic activation, package pruning, ASAR provenance,
Electron fuses, CSP, code signing, entitlements, native libraries, Python locks,
SBOMs, and license metadata.

Distinguish confirmed vulnerabilities from hardening ideas. Do not claim a
backdoor exists without a proven path. Do not add network dependencies or
disable platform protections to make tests pass.

### 6. Code structure and maintainability

Find oversized modules, duplicated policy tables, hidden coupling, dead code,
unsafe casts, swallowed exceptions, generic error messages, and platform
branches that have drifted. Refactor only behind passing characterization tests.

Prefer:

- pure policy functions;
- one source of truth for catalog/platform facts;
- narrow IPC schemas;
- explicit lifecycle state machines;
- bounded timeouts and cancellation;
- errors that retain their original cause and operation context;
- platform adapters behind shared contracts;
- small components whose state ownership is obvious.

Do not perform a cosmetic rewrite of working code. Every refactor must name the
risk it reduces and retain or improve test coverage.

## Baseline commands

Run these before editing and retain their exact exit codes and counts:

```bash
git status --short
git rev-parse HEAD
node --version
npm --version
uv --version
npm ci --strict-allow-scripts
npm run verify:local
npm run test:settings-layout
git diff --check
```

On macOS Apple Silicon, run the complete packaged gate after implementation:

```bash
bash scripts/verify-local-macos.sh
```

If verified local model data and a deterministic WAV fixture are available,
also run the real-model gate using the family/tier under review:

```bash
bash scripts/verify-local-macos.sh \
  --smoke-model-root "$HOME/Library/Application Support/LocalScribe/models" \
  --smoke-audio /absolute/path/to/fixture.wav \
  --smoke-family qwen3-asr-0-6b \
  --smoke-tier medium \
  --smoke-mode after-stop \
  --smoke-repeat 3
```

On the physical Windows NVIDIA machine, use an elevated PowerShell only when
the symlink-security tests require it:

```powershell
npm ci --strict-allow-scripts
npm run verify:local:windows -- -RequireCuda
```

Then run the repository's documented real CUDA/model arguments for Qwen3-ASR
0.6B Medium and record GPU name, total/free VRAM, selected CUDA device, model
identity, load time, repeated warm inference times, transcript, exit code,
artifact names, sizes, and SHA-256 values.

## Required regression tests

At minimum retain or add executable coverage for:

1. Computed cursor style is `default` for application controls across every
   settings tab, platform rendering, supported window size, artifact state, and
   Apply success/failure; editable text remains `text`.
2. Pill controls and scratchpad controls inherit the same cursor contract.
3. All settings pages reach their maximum scroll position; their bottom target
   and all footer controls are visible and not clipped at 900x640.
4. Sidebar navigation remains scrollable at short heights.
5. Model family/tier selection emits zero IPC before Apply.
6. Apply emits exactly one combined family/mode request.
7. Old-model stop happens before target load; no process overlap occurs.
8. Load or persistence failure rolls back without mutating committed routing.
9. Repeated dictations reuse the warm model.
10. Quit during Apply does not reload a rollback model or leave an orphan.
11. Shortcut replacement removes the old runtime binding and updates every UI
    copy site.
12. Auto paste falls back to clipboard when the target changed or insertion
    fails.
13. Draft creation, selection, deletion, and persistence work with multiple
    drafts.
14. Packaged resource inventory, provenance, SBOM, signature, and checksum
    checks fail closed when altered.

## GUI acceptance pass

After automated gates, use the packaged app rather than a development renderer.
Record screenshots or precise observations for:

- idle pill, pill hover, microphone picker, hold-to-talk recording, toggle
  recording, processing, success, and transient error;
- main window close versus explicit app Quit;
- settings General, System, Model & Performance, Writing, Experimental, and
  Data & Privacy at normal and small sizes;
- model selection staged without change, Apply to a second installed family,
  return to the first family, restart persistence, and cold "Load current
  model";
- scratchpad persistence with multiple drafts and focus switching;
- insertion into a real text field and clipboard fallback without a valid
  target.

If a GUI step cannot be automated, label it **NOT TESTED** and give the exact
human action needed. Do not convert source inspection into a GUI pass.

## Final deliverables

Return all of the following:

1. A severity-ordered finding table with file:line evidence, reproduction,
   user impact, root cause, and status.
2. A concise architecture map of renderer, preload, IPC, main lifecycle,
   persistence, platform adapters, workers, manifests, packaging, and update
   boundaries.
3. The implemented fixes and refactors, each tied to a finding or proven risk.
4. Tests added or strengthened for every fixed regression.
5. Exact command results and counts, separated into source, packaged, real
   model, GUI, macOS, and Windows evidence.
6. A list of remaining **NOT TESTED** items and why they remain untested.
7. A clean `git status --short`, final commit SHA, and a reviewable diff summary.
8. Updated documentation where behavior, packages, memory estimates, licenses,
   installation, or validation steps changed.

Stop rather than publish or merge if a release gate fails. Do not upload release
assets from an unverified platform. Never describe the application as perfect;
describe exactly what was proven.

---

The existing source of truth for current model/runtime facts is
`docs/MODEL_CATALOG.md`. Packaging and platform validation are documented in
`docs/PACKAGING.md` and `docs/WINDOWS.md`.
