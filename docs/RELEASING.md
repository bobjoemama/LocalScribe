# Release procedure

LocalScribe has two intentionally different artifact classes.

- **Validation artifacts** are built by normal CI, named
  `UNSIGNED-VALIDATION`, retained briefly, and never represented as public
  releases.
- **Production release candidates** are built only by the manual signed
  workflow in the protected `release` environment.

The workflows never publish a GitHub Release or update feed automatically.

## Common gates

Every release first passes this credential-free verification gate on the exact
tagged commit:

```sh
npm ci --strict-allow-scripts
npm run audit:production
npm run audit:all
npm run worker:check-locks
npm run audit:python
npm run typecheck
npm test -- --reporter=dot
```

`audit:python` exports both committed worker locks, fails if any of the three uv
locks would change, and audits every exact package/version in both platform
graphs with `pip-audit==2.10.1`. The audit tool and its own dependencies come
from `tools/python-audit/uv.lock` via
`uv run --project tools/python-audit --locked`; CI never resolves the audit tool
dynamically. Platform markers are removed only in the temporary audit input so
a Linux runner checks both target graphs; uv's package hashes are retained and
required, and dependency resolution remains disabled.

Runtime build, native helper build, Forge make, whole-package inventory,
separate Node-production and locked platform-Python CycloneDX SBOM generation,
and a SHA-256 manifest covering both SBOMs and the install artifacts must then
pass on the target OS.

The release workflow uses `permissions: contents: read`, disables checkout
credential persistence, pins actions to immutable commits, and does not use
`pull_request_target`. Its `release-verify` job has no environment or secret
references. Both protected signing jobs depend on that job, and each signing
secret is exposed only to the certificate-import or signed-build step that
consumes it.

Manual dispatch must select the tag `v<package.json version>`. A credential-free
gate rejects every other ref and completes all common gates before either
protected signing job starts. All release jobs check out the event's exact
commit SHA rather than a mutable branch or tag name.

## macOS credentials

Required protected secrets:

- `MACOS_CERTIFICATE_P12_BASE64`
- `MACOS_CERTIFICATE_PASSWORD`
- `LOCALSCRIBE_CODESIGN_IDENTITY` beginning with
  `Developer ID Application:`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

The workflow imports the certificate into an ephemeral keychain. With
`LOCALSCRIBE_RELEASE=1`, Forge refuses Apple Development or ad-hoc identities.
The app uses hardened runtime and narrow entitlements, is notarized and
stapled, and is assessed with:

```sh
codesign --verify --deep --strict --verbose=4 LocalScribe.app
xcrun stapler validate LocalScribe.app
spctl --assess --type execute --verbose=4 LocalScribe.app
```

The standalone `native/macos/active-target` accessibility helper is signed
with its own empty entitlement profile. It does not inherit the Electron main
process microphone or JIT grants.

The DMG is signed, submitted to Apple, stapled, and validated separately. The
ZIP contains the already stapled app.

## Windows credentials

For a file-backed certificate:

- `WINDOWS_CERTIFICATE_PFX_BASE64`
- `WINDOWS_CERTIFICATE_PASSWORD`
- `WINDOWS_TIMESTAMP_SERVER` using HTTPS

The workflow materializes the PFX only under `RUNNER_TEMP` and passes its path
to Forge. For an EV, HSM, or managed signing flow, a trusted operator may
instead configure `WINDOWS_SIGN_WITH_PARAMS` plus the HTTPS timestamp server.
Never commit a PFX, password, token, or generated signing command.

Release mode signs the packaged `LocalScribe.exe`, Win32 helper, and Squirrel
artifacts. It fails unless these checks return `Valid`:

```powershell
Get-AuthenticodeSignature LocalScribe.exe
Get-AuthenticodeSignature resources\native\windows\active-target.exe
Get-AuthenticodeSignature LocalScribe-Setup.exe
```

## Release-candidate review

Before publication, verify:

1. package version matches the intended immutable source tag;
2. both platform SBOMs are present and their entries in `SHA256SUMS.txt` match
   the downloaded workflow artifacts;
3. macOS notarization or Windows Authenticode checks pass on the downloaded
   artifact, not only inside CI;
4. no model weights are embedded in the installer;
5. explicit model download, offline dictation, and tamper rejection work;
6. fresh-user permissions, hotkeys, paste fallback, tray, login, and local data
   paths work on the target OS;
7. Windows real inference passes on physical NVIDIA hardware;
8. installer update/uninstall behavior is tested before any update feed is
   enabled.

If any credential is absent, `LOCALSCRIBE_RELEASE=1` fails before packaging.
Do not remove that gate to obtain an artifact; use the validation workflow
instead.
