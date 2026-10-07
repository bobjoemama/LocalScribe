# LocalScribe interface redesign

The October 7, 2026 source candidate (0.1.0-dev.21) implements the Mac portion
of the user-approved Fable design brief. Its warm paper/ink palette, direct labels
and recording feedback replace the earlier navy workspace and disabled placeholder
pages. The current candidate has **not been activated in the installed Mac app**.
Prior activation evidence below describes earlier builds.

The brief covers both platforms. The native iPhone implementation and its
recording, keyboard, Action Button, Live Activity and phone performance surfaces
live in [LocalScribeiOS](https://github.com/bobjoemama/LocalScribeiOS). That project's
records own its build, installation and physical-device verification status.
LocalScribe uses its own name, brand mark, copy and implementation; Wispr source
and assets are not incorporated.

## Current design system

- Shared semantic tokens are defined in src/renderer/workspace-theme.css and
  used by workspace, settings, library, menus and Notes. Light canvas is
  #F3F1ED, dark canvas #141312; surfaces are white / #1E1C1A, with warm
  inset and raised surfaces. Neutral primary actions use contrasting ink.
- Recording red, success green, warning amber and error red communicate state.
  The implemented light recording color is #D3352A, dark #FF5F52. Control
  boundaries and focus use stronger contrast than decorative separators.
- System sans-serif typography uses 20px page titles, 13px controls and 14px
  transcript text. Timers and measurements use tabular numbers. Shared spacing,
  restrained corner radii and separators replace nested dashboard frames.
- Settings → System now persists **System / Light / Dark**. Main applies
  nativeTheme.themeSource before windows open and after durable Save. Hub and
  Notes native backgrounds follow the effective theme, including later system
  changes. The black recording pill remains black in all appearances.
- Keyboard focus, reduced-motion behavior, adaptive menus and small-window
  layout remain explicit. The supported hub sizes remain 1220×760 and 900×640.

## Current surface coverage

| Surface | Implemented behavior |
| --- | --- |
| Hub | Text sidebar: Dictation, Insights, Notes, Dictionary, Snippets, Cleanup, Models; Settings and version below. One separator replaces the rounded content frame. ⌘1–⌘7 navigate, ⌘, opens Settings, ⌘F focuses list search. |
| Dictation | One compact line shows saved shortcuts, model and recognition mode, with direct Settings/Models actions. Search, export, copy-visible, clear-history, date groups, complete selectable transcripts, copy feedback and unreadable-history recovery remain. The duplicate Today/Summary side panel is removed. |
| Insights | Period selection, plain usage figures, activity chart and source-app categories remain. Writing contains measured pace, sentence length, word variety and frequent words with a deterministic-data explanation. The personality headline and separate Voice profile tab are removed. |
| Dictionary / Snippets | Search, counts, readable rows, Say / Replace with or Say / Insert editors, validation, identity-aware saves, discard confirmation, deletion and unreadable-store recovery remain. Failed saves retain the draft. Custom replacement rules use the existing dictionary rather than a separate rule store. |
| Notes | Existing dedicated encrypted note window, search, New note, note list, autosave, Copy, Delete and resizing remain. System-font editor and shared surfaces replace the serif presentation. Escape drains queued saves through the existing close path. Disabled rewrite/format tools are removed. Storage and IPC identifiers retain scratchpad for compatibility. |
| Cleanup | None / Light / Medium presets plus derived Custom state map to the existing filler, spoken-command and punctuation flags. Changes apply immediately. App-profile create/delete controls remain, with confirmed deletion; word replacements link to Dictionary. Legacy Style/Transforms links open Cleanup. Disabled tone and rewrite cards are removed. |
| Models | Dedicated sidebar page reuses the existing catalog and operation controller. Current/pending selection, explicit Apply/Load current model, Live / After I stop, quality preference, advisory memory details, family/profile comparison, downloads, verification, Repair, Remove, Check, Refresh, Download all, sort/filter and technical/source disclosures remain. Model operations still guard navigation and dismissal. Precision labels describe CPU/GPU/Neural Engine paths. |
| Settings | General: both shortcut recorders, microphone, dictation language, app language and permissions. System: login startup, floating bar, automatic paste, appearance, history and retention. Data & Privacy: local-processing/database/revision status, data-folder action, export, recovery copies, reset, clear history and diagnostics. Shortcut changes apply immediately; other fields retain Cancel / Save changes. Removed Model/Writing content is reachable through Models/Cleanup; disabled Experimental switches are removed. |
| Recording pill | Existing non-focusable black capsule, hover actions, microphone menu and session states remain. Recording dot and elapsed timer use real session start. Live text distinguishes recent words and allows reading earlier text with Latest to resume following. Finish/Cancel, processing, copy/paste notices, error details and dismissal remain. Native listening/live dimensions are unchanged. |
| Native menus | Tray uses the original L silhouette as a 16pt template image with 1x/2x representations. Tray/app menu labels say Notes. ⌘W uses the existing hide-on-close boundary; Quit retains full teardown. |
| Metrics companion | Separate companion retains live device/code Start/Stop and trace-report workflows. Its source is maintained in the iPhone repository; collector failures are surfaced rather than discarded. |

## Runtime, storage and lifecycle continuity

The redesign preserves bundle identity, Keychain encryption, user records, model
files, pinned runtime adapters, microphone/accessibility grants and registered
Control–Space. Source edits and fixture tests do not modify installed app state.
Closing the Mac window hides it; actual Quit/⌘Q ends capture, hotkeys, worker and
loaded-model resources. Window visibility still controls hidden permission polling.
The appearance listener is retired during shutdown.

Model browsing and installation remain separate from runtime activation. Only
explicit Apply commits a changed Mac model selection. Memory estimates and missing
telemetry remain advisory, and runtime loading failures retain the saved selection.
Cleanup and dictionary corrections remain deterministic local operations. No cloud,
account, subscription, generation model, daemon or dependency was added.

## Verified limits and departures from the brief

- The alleged paste parser defect was not present. The Swift helper returns
  injected after posting Command–V, with no receiving-app consumption receipt.
  nativePlatformBridge.ts faithfully parses that response. safeInsertion.ts
  deliberately keeps the transcription copied when acknowledgment is absent.
  A dispatched event is not proof of insertion, so the redesign retains honest
  paste-sent/copy-backup feedback and conditional restoration. It does not
  manufacture an “Inserted” receipt or restore the clipboard prematurely.
- Individual Mac downloads have no supported cancellation contract. The existing
  bulk **Stop after current** behavior remains; current artifact download and
  verification finish before the next package is skipped. No per-file Cancel
  control promises an abort that the worker cannot perform.
- Drag-to-snap pill placement remains outside this change. Existing placement and
  the non-focusable panel's focus-preservation behavior remain intact.
- iPhone background microphone activation, clipboard delivery, actual Dynamic
  Island rendering and keyboard host insertion remain physical-device checks,
  owned by the iPhone project. The design brief does not establish those results.

## Verification and activation status

Focused platform checks passed for appearance persistence/migration, native canvas
updates, navigation compatibility, shutdown behavior and existing safe insertion.
An isolated Electron check decoded both tray representations, confirmed template
image status and built the Close menu role. Synthetic renderer fixtures exercise
light/dark workspace and dialog states without loading a model, changing the system
clipboard or reading personal records. The full source gate passed 1,575 tests
with two existing skips, toolchain/dependency audits, lint and TypeScript. Sixteen
native Chromium scenarios passed across both appearances and 1220×760/900×640,
including model-operation guards, Apply success/failure, editing, focus, scrolling
and appearance persistence. Eighteen additional Notes/pill captures and real
fixture interactions passed, including save-drain on Escape and Latest re-follow.
See [current synthetic captures and reports](previews/redesign-20261007/README.md).

The signed 0.1.0-dev.21 build replaced `/Applications/LocalScribe.app` on October 7
after its Dictation menu confirmed idle. Actual Command–Q ended all nine tracked
app/helper/worker processes. Bundle signatures, nested entitlements, resource
integrity, archive checks and the complete designated requirement passed; the
installed archive matches the candidate. Startup and Control–Space registration
passed, Canary-Qwen and the 53 readable history entries remained. Only LocalScribe
restarted; the prior bundle is in recoverable Trash. No user data/model reset,
physical microphone test or new notarized/public binary release was performed.

## Desktop recovery and recording fixes

Settings → Data & Privacy provides **Reset saved data…** and **Show recovery copies**.
Reset uses a native confirmation, first saves a consistent encrypted SQLite backup,
then clears history, dictionary, snippets and saved notes in one transaction.
Models, settings, shortcuts and app profiles remain unchanged. Active dictation
and model operations must finish first; competing saved-data writes are blocked
until reset completes. Backup failures preserve the original store. The recovery
copies use the same Keychain key; they cannot restore a previously lost key.
Unreadable dictionary/snippet entries show their count and a direct recovery link.

New library items are revealed even under an active search. Saving locks editor
fields; correcting a failed draft clears its stale error. History refreshes keep
existing readable rows and focus visible, including when refresh fails. Deletion
notifications also refresh other views when deletion committed but WAL cleanup
could not finish. New notes clear search and expand the notes list.

Recorder generations reject stale queued audio. Stop/Cancel release microphone
and recorder state even if audio-context closure fails. Recorder teardown also
runs on session errors and pill unmount; late settings responses cannot restart
capture after disposal. Focused regression tests cover these failure paths.

## Historical release and activation records

The following records describe prior October 4 builds. Their successful startup,
shortcut registration and fixture results do not verify the current candidate.

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

The dictionary/snippet editors, direct model-settings navigation, advisory memory
policy and plain Dictation page were built from commit `2d9b242` in
`out/ui-memory-controls-20261004/` and activated on 4 October 2026. The installed
archive matches the reviewed signed candidate. Strict signature, complete
designated-requirement identity, resource integrity, signed Python imports and
startup checks passed. Hold and toggle shortcuts registered successfully, with
Control–Space retained. The activation review showed Canary High selected.
Only LocalScribe restarted; macOS did not. The replaced bundle was removed after
verification, while model files and user data stayed in place.

The functional source gate passed with 1,519 tests and two skipped tests. The final
copy-only cleanup passed typecheck, 23 focused history tests, and the complete
light/dark renderer harness at both supported sizes. These checks do not measure
actual Canary allocation, speech accuracy or microphone-to-target dictation after
activation. This local build has no new notarization ticket and is not a new
published binary release.

The isolated renderer fixture uses synthetic library entries and an in-memory save stub; real database
tests separately verify encrypted, identity-aware persistence and reopen behavior.
Neither fixture accesses user records, changes the system clipboard or invokes
the installed application. Scratchpad already has encrypted note persistence,
autosave, search, New note and Copy; Style already has application categories and
concrete before/after examples, so those surfaces need no parity-only additions.
