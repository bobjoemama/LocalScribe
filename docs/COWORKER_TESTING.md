# Coworker macOS validation runbook

This runbook transfers one exact LocalScribe macOS arm64 candidate to a
coworker without confusing source checks with native desktop acceptance. Use a
DMG or ZIP and checksum manifest produced together by
`npm run verify:local:macos`.

## Access and scope

- The repository and validation releases are currently private. Invite the
  tester to the repository before sharing the GitHub Release URL.
- The supported target is an Apple Silicon Mac running macOS 14 or newer.
- This is a native macOS app, not a Docker service. Python, Node.js, Docker,
  Homebrew, and Xcode are not required on the tester's Mac; runtime dependencies
  are bundled. Speech-model weights are a separate, explicit in-app download.
- Check the exact release notes for signing and notarization status. Private
  repository access does not itself establish or prevent Apple notarization.
- The tester should use a non-critical macOS account or back up existing
  LocalScribe data before testing rollback or migration behavior.

## What to send

Send these files from the same versioned build:

```text
LocalScribe-<version>-arm64.dmg
LocalScribe-darwin-arm64-<version>.zip
LocalScribe-<version>-macos-arm64-SHA256SUMS.txt
```

The checksum manifest also names the two runtime SBOM files produced by the
full gate. Download those SBOMs too: all five release assets must be in one
directory for the manifest command to succeed. Do not rename individual
assets, combine files from different builds, overwrite an older release asset,
or reuse a version for different bytes.

Record alongside the files:

- the full Git commit SHA and version;
- the DMG and ZIP SHA-256 values;
- the signing identity reported by the package gate;
- whether Developer ID signing, notarization, and stapling were performed;
- which source, packaged, and real-model gates passed on those exact bytes.

## Verify before opening

In Terminal, from the directory containing every file named by the checksum
manifest:

```sh
cd /path/to/downloaded/assets
shasum -a 256 -c LocalScribe-<version>-macos-arm64-SHA256SUMS.txt
```

Proceed only if every line reports `OK`. A missing file, `FAILED`, or checksum
manifest from another version invalidates the transfer. Do not rely on a hash
copied from an untrusted message instead of the manifest transferred through
the agreed channel. The manifest contains flat release-asset basenames and
rejects duplicate names, so no directory reconstruction is required.

## Install or upgrade

1. Quit every running LocalScribe process.
2. Keep `~/Library/Application Support/LocalScribe/` in place. Replacing the
   application must not delete the database, settings, diagnostics, or models.
3. For the DMG, open it and copy `LocalScribe.app` to `/Applications`, replacing
   only the older application bundle. For the ZIP, extract it and copy the
   resulting `LocalScribe.app` to `/Applications`.
4. Launch the installed application and record the displayed version before
   testing.

Model weights are intentionally not included in the application or DMG. On the
first run, explicitly add Parakeet Unified EN 0.6B in **Settings -> Model &
Performance**, choose High FP16 or Medium INT8, and press **Apply model**. That
installation requires network access. Once the model is installed and ready,
normal dictation must work offline and must not download or substitute another
model.

Private validation builds may be Apple Development- or ad-hoc-signed and may
not satisfy public Gatekeeper policy. If macOS blocks the candidate, stop and
report the exact message. Do not disable Gatekeeper, SIP, the firewall, TCC, or
other system-wide security protections, and do not remove quarantine metadata
to make an unapproved build appear trusted.

For rollback, quit LocalScribe and replace only `/Applications/LocalScribe.app`
with a previously checksummed compatible candidate. Do not roll back after a
database migration unless that version's compatibility has been explicitly
verified. Back up the LocalScribe user-data directory before testing a rollback
that crosses storage-schema versions.

To uninstall only the executable, quit LocalScribe and move
`/Applications/LocalScribe.app` to Trash. User data and downloaded models are
preserved. Removing them is a separate, destructive action and must be
explicitly authorized after any desired backup.

## Physical acceptance matrix

Perform these checks manually on the exact installed candidate. GUI automation
is not required and does not substitute for the observations below.

1. Confirm Microphone and Accessibility permissions are requested and reported
   truthfully without weakening macOS security settings.
2. In a normal third-party editable target such as TextEdit, test the persisted
   hold and toggle shortcuts shown by LocalScribe.
3. In **After I stop**, dictate a phrase covered by a non-empty Dictionary rule.
   Confirm the corrected text is inserted once and the final transcript appears
   once in history.
4. In **Live**, confirm partial text is visible, only one final result is
   inserted, cancellation produces no insertion/history row, and the next
   session contains no stale partial.
5. Deny or disable automatic insertion and confirm copy-only fallback without
   changing system-wide security protections.
6. With a model warm, quit LocalScribe and confirm Electron, the Python worker,
   active-target helper, and FluidAudio helper exit.
7. Relaunch, start the first dictation, and confirm the persisted selection
   loads lazily without a model download or silent family/profile fallback.

Record the target application, shortcut mode, model family/profile, dictation
mode, result, and exact failure text for every row. Do not mark an unobserved
row as passed.

## Results to return

Copy this template into the test report:

```text
LocalScribe version:
Git commit:
macOS version:
Mac model / memory:
Install result:
Signing or Gatekeeper message, if any:
Microphone permission: PASS / FAIL / NOT TESTED
Accessibility permission: PASS / FAIL / NOT TESTED
Hold shortcut: PASS / FAIL / NOT TESTED
Toggle shortcut: PASS / FAIL / NOT TESTED
After-stop insertion + Dictionary + history: PASS / FAIL / NOT TESTED
Live partials + final insertion + history: PASS / FAIL / NOT TESTED
Live cancellation and next-session reset: PASS / FAIL / NOT TESTED
Copy-only fallback: PASS / FAIL / NOT TESTED
Warm quit process cleanup: PASS / FAIL / NOT TESTED
Relaunch and offline lazy load: PASS / FAIL / NOT TESTED
Target application(s):
Exact failure text and reproduction steps:
```

Do not include dictated text, clipboard contents, recordings, model files,
database files, credentials, or unredacted private paths in the report. Use
LocalScribe's redacted diagnostics action when diagnostic evidence is needed,
and review the result before sharing it.

## Evidence boundary

Source tests, lint, type checking, dependency audits, package inventory,
signature checks, SBOM verification, and packaged real-model smoke are valuable
but do not prove physical microphone capture, macOS TCC consent, global
shortcut delivery, focus preservation, paste consumption, copy-only behavior,
clean-account setup, or worker/helper exit on the coworker's Mac.

Docker Compose cannot supply that evidence. LocalScribe is a native Electron,
Core ML/ANE, and macOS Accessibility application; a Linux container cannot run
or validate its TCC permissions, global input hooks, third-party target focus,
native accelerator path, codesigning, or DMG installation. Compose may be used
for non-authoritative source tooling only, and any such result must remain
labelled source-only.
