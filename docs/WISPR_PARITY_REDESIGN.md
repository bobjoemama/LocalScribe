# LocalScribe Wispr-parity redesign

The original product inventory was made by observing the installed Wispr Flow application
through macOS Accessibility and screenshots. The October 2026 workspace refresh gives
LocalScribe its own visual system while retaining the implemented local features. It uses
the LocalScribe name, original icons, original copy, and no Wispr assets or source code.
The installed application is not updated by a source-code edit; deployment is a separate step.

## Accepted direction: minimal, functional, system appearance

The first October 2026 concept was rejected as decorative. This revision removes
promotional slogans, decorative waveform/brand artwork, sidebar category labels,
and repeated local/privacy badges. Screen names and controls describe their function.
The earlier signed candidate in `out/ui-redesign-20261004` is superseded and preserved;
Devesh subsequently authorized rebuilding and replacing the installed app without restarting macOS.

## Design system

- Native system sans-serif; 26px page titles, 13px controls and 14px transcript text.
- Light canvas (`#edf1f6`) with white content; dark canvas (`#171c24`) with
  content (`#202631`) and elevated surfaces (`#2a3443`). Thin gray separators,
  restrained shadows and 6–14px corner radii communicate surface hierarchy.
- Blue marks actionable primary controls, links, selected navigation and keyboard
  focus. Hover and pressed states remain distinct without moving controls. Success,
  warning and error states retain distinct colors in both appearances. Primary
  action text remains at least 4.5:1 in normal, hover and pressed states.
- CSS `color-scheme: light dark` and `light-dark()` follow macOS system appearance
  and respond when it changes. There was no persisted appearance setting in the
  application; this revision adds no new preference or IPC contract.
- Shared tokens live in `src/renderer/workspace-theme.css`. Existing settings,
  history, library and scratchpad colors also have explicit dark equivalents so
  dark appearance covers nested controls, menus, dialogs and model status.
- The floating bar retains its established presentation, dimensions and behavior.

## Application shell

- A 196px text sidebar lists Dictation, Insights, Scratchpad, Dictionary, Snippets,
  Style and Transforms. Settings and the application version remain below.
- Main content scrolls independently. The supported sizes remain 1220×760 and
  900×640. Existing model apply, focus, dismissal and save boundaries remain intact.

## Screens

### Dictation

- Direct `Dictation` title and existing settings-dependent history status.
- Actual saved hold and toggle shortcuts are visible at both supported sizes;
  `Edit shortcuts…` opens the existing guarded Settings modal.
- The saved dictation model and performance preference are visible below the
  shortcuts. `Choose model…` opens Model & Performance directly. Opening it does
  not apply a model or change saved settings; the label does not claim model
  readiness or an effective Auto tier. It reads the existing settings snapshot,
  without hashing downloaded model files or starting a worker.
- Search, export, copy and overflow actions; today-grouped selectable transcript
  text; compact Today and Summary statistics. No promotional banner or privacy badge.
- Short transcripts fit their text; long transcripts retain a bounded, scrollable
  read-only field containing the complete value. Row hover and focus emphasize
  the current record. Copy feedback is visible and announced without interrupting.
- Native overflow disclosures use the same adaptive raised surface as dialogs.
  Only one opens at a time. Escape closes and restores trigger focus; outside click
  and action selection close it. Arrow keys, Home and End navigate its ordinary
  buttons, and focused actions have a small blue outline. Popup placement adapts
  above or below its trigger within the content viewport.
- Transcripts and actions retain the existing local persistence and encryption paths.

### Insights

- Tabs: Usage and Voice profile. Team leaderboard is omitted because LocalScribe has no team
  service.
- Usage cards derive word count, estimated WPM, duration, app count, source-app categories,
  and recent streak data from encrypted local transcript metadata.
- Voice profile is a deterministic, clearly labeled local summary; it must not pretend to be
  a generative analysis.

### Dictionary and snippets

- Header with `Add new`, search, bordered list rows, and a dismissible concise
  introduction with useful examples. Decorative onboarding artwork is hidden.
- Add/edit surfaces are centered modals. Dictionary supports heard phrase and preferred
  spelling. Snippets support spoken trigger and expansion.
- Each saved row has explicit `Edit` and `Delete` actions. Editing opens the same
  accessible dialog with its existing values; unchanged drafts cannot be saved.
  Cancel writes nothing and returns focus to Edit. Add new starts a blank draft.
- Saves address the entry by identity, preserving its creation time when a phrase
  or trigger is renamed. A case- or Unicode-equivalent collision with another
  entry, a stale identity, or an unreadable potentially duplicate rule rejects
  the save. The draft remains available for correction or retry. Encryption
  failure preserves the prior stored fields, and snippet whitespace is retained.
- No sharing/team controls.

### Style

- Tabs: Personal messages, Work messages, Email, Other, Auto cleanup.
- Style cards: Formal, Casual, Very casual/Excited where appropriate, with realistic preview
  cards. Existing local app profiles remain reachable from this screen.
- Auto cleanup levels: None, Light, Medium. Only behavior implemented by the deterministic
  local cleanup pipeline may be promised.

### Transforms

- Local deterministic controls for Polish and spoken structure, plus a
  custom-rule editor surface. These perform exact, source-defined transforms.
- Concise semantic rewriting remains visibly disabled because it requires a
  separately installed local text-generation model. The ASR model does not
  provide rewriting, and deterministic cleanup must not be described as an LLM
  transformation.

### Scratchpad

- Scratchpad opens in its existing dedicated compact note window with search/new controls,
  a note list, and encrypted editor. The palette and native sans-serif editor match the hub.
- Save behavior, independent window dimensions, and local storage remain unchanged.

### Settings modal

- Modal overlay with internal sidebar: General, System, Model & Performance, Writing,
  Experimental, Data & Privacy. Navigation, scroll ownership, fixed footer, focus trapping,
  and guarded dismissal remain in the existing implementation.
- General: hold-to-talk shortcut, microphone, dictation language, app language, permissions.
- System: login item, floating bar, automatic paste, history, retention.
- Model & Performance: curated model catalog, profile comparison, download/verification,
  and explicit model Apply. Workspace styling does not change model selection behavior.
- Memory ranges and reported availability are advisory. Apply is gated by verified
  installed artifacts, supported capabilities and language, and operation state;
  an exceeded estimate or missing telemetry does not block explicit or Auto loading.
  Auto starts with the highest supported profile estimated to fit reported memory,
  falling back to the lowest supported profile if telemetry is unknown or no
  estimate fits. The UI does not invent memory released by a resident model.
  Actual loading failures remain visible, with the saved selection retained.
- Writing: app profiles, style/cleanup explanation, dictionary/snippet shortcuts.
- Experimental: command mode, press-enter command, stacked messages, bulk import (only mark a
  switch active when its behavior exists).
- Data & Privacy: local-only processing, context boundaries, encrypted storage, export, clear,
  model removal, data/model paths, diagnostics.

## Floating bar

- Idle state collapses to a quiet 42x7 warm-gray/black capsule at bottom center.
- Hover/focus expands to an original compact LocalScribe control with the black `L`, shortcut
  hint, and settings action.
- Listening expands to a dark capsule with an original animated waveform; processing shows a
  restrained progress treatment; success/error collapse after feedback.
- Microphone access is never triggered merely to inspect or hover over the bar.

## Privacy and correctness boundaries

- Preserve sandboxed renderer, narrow validated IPC, OS-encrypted private text fields, raw-audio deletion,
  target-guarded insertion, conditional clipboard restoration, pinned model revision/hash,
  hardened fuses, and no listening server.
- Never copy Wispr source, assets, screenshots, account/team data, private text, or proprietary
  wording into LocalScribe.
- UI controls must either call an existing local implementation or clearly communicate that
  they are informational; no deceptive functional parity.

## Verification and activation boundary

`npm run typecheck`, `npm run lint`, renderer UI tests, and the isolated settings
layout harness verify source behavior and rendering. Optional fixture captures use
`LOCALSCRIBE_LAYOUT_SCREENSHOT_DIR` and `LOCALSCRIBE_LAYOUT_APPEARANCE=light|dark`.
The same complete hidden test package renders actual workspace pages with synthetic
history; it does not launch the product app, access user history or change macOS appearance.

A separately packaged candidate reuses the existing Developer ID, bundle identifier
and hardened runtime. Packaging validates source provenance, resources, entitlements
and signatures. On 4 October 2026, the fresh signed build from `out/ui-installed-20261004/` replaced `/Applications/LocalScribe.app`. Only LocalScribe restarted; macOS did not. Strict signature and installed archive checks passed, startup completed, and hold/toggle shortcut registration succeeded. The saved toggle remains Control–Space. The old installed bundle was removed after these checks; user data and downloaded models were left in place.

This local update has no new notarization ticket and is not a new published binary release. Physical microphone-to-target dictation and encrypted-history/OS permission continuity still require hands-on verification; successful startup and shortcut registration alone do not prove those workflows. The native iOS counterpart is in [LocalScribeiOS](https://github.com/bobjoemama/LocalScribeiOS).

The subsequent surface and interaction refinement was built from commit `31bcdeb`
in `out/ui-refined-20261004/` with Electron 43.7.7 and activated on 4 October 2026.
The installed archive matches the reviewed candidate; strict signature checks and
startup/hold/toggle registration passed. Only LocalScribe restarted, and the replaced
bundle was deleted after verification. User data, models and shortcut settings stayed
in place. Earlier in this session, the prior installed redesign recorded successful
transcription and insertion events; those do not establish speech accuracy or full
verification of this later refinement.

The isolated renderer checks pass for open header and row menus, keyboard focus,
dismissal, copy feedback, bounded transcripts and library dialogs at both supported
sizes and appearances. Fixture clipboard writes stay in memory; no user transcript
or model is used. Full source gates passed with 1,500 tests and two skipped tests;
the exact unpatched build-only audit residual is documented in `docs/RELEASING.md`.

The subsequent dictionary/snippet editing and direct model-settings navigation
are source changes pending packaging and activation. Their isolated renderer
fixture uses synthetic library entries and an in-memory save stub; real database
tests separately verify encrypted, identity-aware persistence and reopen behavior.
Neither fixture accesses user records, changes the system clipboard or invokes
the installed application. Scratchpad already has encrypted note persistence,
autosave, search, New note and Copy; Style already has application categories and
concrete before/after examples, so those surfaces need no parity-only additions.
