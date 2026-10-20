# LocalScribe macOS tasks

## Current work — insertion and installed-app updates

Devesh reports that public dev.24 does not insert dictated text in any app on
another Mac. The affected Mac's exact completion message, clipboard behavior and
Accessibility status are not yet known. The orchestrator requested those facts;
the confirmed scope is every app, not one browser. The working Mac installation,
Control–Space, data, model selection and app/signing identities must be preserved.

- [x] Investigate the shared insertion failure and repair confirmed diagnostic loss.
  Devesh reports insertion recovered on the other Mac before this patch was
  delivered; the cause remains unverified. Seven diagnostic regression cases
  failed before the fix; 101 focused tests passed afterward. The private AppKit
  probe measured one clipboard change per text write, so safety gates stay intact.
- [x] Review existing macOS updater implementations and recommend a signed,
  explicit-install update flow that preserves active dictation and user data.
  Devesh approved signed in-app updates. Electron 43.7.7's built-in Squirrel
  avoids a new dependency; static per-release feeds include prereleases. Source
  confirms signature validation and staging on normal process exit, but no ZIP
  digest enforcement in this pinned runtime. Automatic checks fetch metadata only.
- [x] Implement the verified fixes and agreed updater; verify the real native
  and lifecycle boundaries plus the changed UI on an isolated development copy.
  Three review rounds ended with no findings above low. A real signed Squirrel
  fixture updated and relaunched; light/dark Updates and real React Notes checks
  passed. The first full source run passed 1,809 tests and found seven failures
  in stale window fixtures and premature README publication links; both were
  corrected, and all 21 affected tests passed. Final pre-push verification follows.
- [ ] Commit/push the completed changes and publish a new signed, notarized DMG,
  update ZIP and any required feed. Do not overwrite an older version's assets.
- [ ] Verify the exact public download and document the one manual bootstrap
  install required for an already-installed dev.24 with no updater.

The DMG file is an installer, not an update channel for existing installations.
No repair of the other physical Mac has been verified. Existing release evidence
is in [delivery plan](docs/DELIVERY_PLAN.md); prior model research remains a
separate proposed comparison in [model evidence](docs/MODEL_COMPARISON_EVIDENCE.md).

## Waiting on Devesh

- Refresh the existing `localscribe-notary` credential locally. Apple's
  `notarytool history` returned HTTP 401 on 19 October; no secret was read or
  printed. The question card gives the Apple Account and Terminal steps.
  Source/testing/signing can continue; new notarization/publication waits.

Devesh reported insertion working and approved signed in-app updates. If
insertion recurs, capture Copy diagnostics after a failed attempt and whether
Command–V pastes the transcript.

## Final review

Round 1 found an update restart could bypass pending Notes saves and unsaved
Settings, and that metadata failure during ordinary quit could be mistaken for
installation failure. Editor acknowledgement and shutdown classification fixes
passed focused verification, with a failing-before lifecycle test. The publication CLI now
requires the exact update feed as a separately hashed sixth asset; seven focused
publication tests pass. The real signed Squirrel test replaced/relaunched two
isolated fixture versions with the same code identity, path and profile; receipt
and verified cleanup are in `/tmp/localscribe-native-update-evidence-aFz8RV`.
System → Updates passed light/dark interaction/layout at 1220×760 and 900×640,
including persisted opt-out and keyboard focus. Actual React Settings preserves
drafts on veto; Notes waits for durable saves, retains failed drafts and retries.
The orchestrator inspected all four Updates captures and the Notes capture.
Minimum measured text contrast was 5.62:1 light and 6.77:1 dark, with no captured
renderer console errors. The focus-stealing native Accessibility harness remains
unrun; no repair of the other Mac's insertion or permission state is claimed.
