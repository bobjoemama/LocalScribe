# Windows insertion helper

`active-target.cpp` is a dependency-free Win32 console helper. It uses:

- `GetForegroundWindow` and `GetWindowThreadProcessId` for the destination window;
- `GetGUIThreadInfo` plus UI Automation `ValuePattern`/`TextEditPattern`
  metadata to identify the focused editable control without reading its text;
- `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` and `QueryFullProcessImageNameW` for a stable application identity;
- Windows CNG (`BCrypt`) to SHA-256 hash the PID, opaque window handles, and
  UI Automation runtime ID into the focused-target fingerprint;
- `GetClipboardSequenceNumber` so LocalScribe never restores over a clipboard another process changed.
- `SendInput` for a bounded Ctrl+V sequence only after a second editable-focus
  check; unsupported, elevated, changed, or non-editable targets remain copy-only.

No window title or window contents leave the helper. Capture fails closed if the
foreground window or focused control changes while its identity is being queried.
The helper never receives transcript text or clipboard contents.

## Build and verify

Install Visual Studio 2022 Build Tools with **Desktop development with C++**.
From PowerShell at the repository root, run:

```powershell
& .\resources\native\windows\build.ps1
```

The script discovers an installed Visual Studio 2022 x64 C++ toolchain (or uses
an already configured x64 developer environment), compiles with MSVC security
hardening enabled, creates:

`resources/native/windows/active-target.exe`

and runs deterministic self-test/clipboard checks that also work in a
non-interactive Windows CI session. When an interactive foreground desktop is
available it additionally validates the live target payload. Manual checks are:

```powershell
.\resources\native\windows\active-target.exe self-test
.\resources\native\windows\active-target.exe target
.\resources\native\windows\active-target.exe clipboard-sequence
```

The commands return:

- `self-test` verifies the x64 build and the helper's SHA-256 primitive without
  requiring a foreground desktop.
- `target` writes one JSON object containing `platform: "win32"`, a positive
  `processId`, a stable `applicationId`, a 64-character SHA-256
  `windowFingerprint`, and a boolean `focusedEditable`.
- `clipboard-sequence` writes `{ "sequence": number }`, backed by `GetClipboardSequenceNumber`.

`paste` is intentionally omitted from manual smoke commands because it may
inject Ctrl+V. LocalScribe invokes it as
`paste win32 <pid> <application-id> <window-fingerprint>`. The helper recaptures
the editable target immediately before `SendInput` and injects only when all
identity fields match. It never receives transcript or clipboard content and
returns `{ "injected": boolean }`; a false result keeps the dictated text copied
for manual paste. Windows UIPI intentionally prevents injection into
higher-integrity applications.

The generated executable must be added to the packaged app's resources at
`resources/native/windows/active-target.exe` and Authenticode-signed before
distribution. Signing credentials deliberately do not belong in this script or
repository.

## Verification boundary

This helper cannot be compiled or executed on macOS without a Windows SDK/MSVC
toolchain. A successful macOS TypeScript test run proves only the Electron-side
JSON validation and fail-closed behavior. Run `build.ps1` in Windows CI on every
helper change to establish native compile and live Win32 API evidence.
