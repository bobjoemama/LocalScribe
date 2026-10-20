# LocalScribe macOS tasks

## Current work — insertion and installed-app updates

Devesh reported that public dev.24 did not insert dictated text in any app on
another Mac, then reported recovery before this patch was delivered. The cause
remains unknown; the diagnostic fix does not establish a repair of that Mac.
The working Mac installation, Control–Space, data, model selection and app/signing
identities must be preserved.

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
  Implementation is committed/pushed as `4306c71` (PR #44). Three review rounds ended with no findings above low. A real signed Squirrel
  fixture updated and relaunched; light/dark Updates and real React Notes checks
  passed. The first full source run passed 1,809 tests and found seven failures
  in stale window fixtures and premature README publication links; both were
  corrected, and all 21 affected tests passed. Final pre-push verification passed
  all audits, lint, typechecking and 1,816 tests; two bundled-runtime cases skipped
  in that source run subsequently passed in the 10-test packaged-runtime suite.
- [x] Commit/push the completed changes and publish a new signed, notarized DMG,
  update ZIP and any required feed. Do not overwrite an older version's assets.
  PR #44 merged as `c31c8c8`; the annotated `v0.1.0-dev.25` tag pins that exact
  source. A fresh public build passed Developer ID signing, app/DMG notarization,
  stapling and Gatekeeper, then shipped all six assets at
  [dev.25](https://github.com/bobjoemama/LocalScribe/releases/tag/v0.1.0-dev.25).
  Exact-app artifact, entitlements, bundled inference imports, startup/shutdown,
  10 runtime tests and 73 Python tests passed. SBOMs/checksums were generated.
  The first build stalled in Xcode 27's SDK stat-cache validation; a process sample
  showed CFRunLoop waiting. The owned cache process was stopped, and the same
  pinned Swift package built with `swift build --build-system native`. A temporary
  launcher selected that supported alternative; no project/toolchain setting changed.
- [x] Verify the exact public download and document the one manual bootstrap
  install required for an already-installed dev.24 with no updater.
  An independent subagent downloaded all six public assets without credentials;
  lengths/digests matched GitHub and the upload inventory, and SHA256SUMS passed
  4/4. The public DMG and both enclosed/extracted apps passed strict signatures,
  stapler and Gatekeeper. The actual metadata backend discovered dev.25 without
  starting a native download. README links advanced only after this verification.
  Public artifact receipt: `/tmp/localscribe-dev25-public-test-20261019-0rayzp/result.json`.
  Durable release identity and limits: [delivery plan](docs/DELIVERY_PLAN.md).

The DMG file is an installer, not an update channel for existing installations.
No repair of the other physical Mac has been verified. Existing release evidence
is in [delivery plan](docs/DELIVERY_PLAN.md); prior model research remains a
separate proposed comparison in [model evidence](docs/MODEL_COMPARISON_EVIDENCE.md).

## Waiting on Devesh

Nothing. Devesh generated a fresh app-specific password and saved it with Apple's
interactive prompt. `notarytool history` validated the refreshed Keychain profile,
and Apple accepted both new submissions. No secret value was read or printed.

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

Fresh public build logs: `/tmp/localscribe-dev25-public-build-20261019.log`
and `/tmp/localscribe-dev25-public-package-gates-20261019.log`. The latter ran the
existing packaged-runtime/smoke/worker/SBOM/checksum gates individually, not the
complete macOS script containing the skipped Accessibility harness. Public
notarization and download verification are complete. Fresh physical insertion and
a real two-version LocalScribe upgrade remain untested; the installed working app
was neither restarted nor replaced.
