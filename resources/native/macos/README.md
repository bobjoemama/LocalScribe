# macOS insertion helper

This helper exposes a small fixed command set:

- `active-target target` returns the frontmost process identity and a SHA-256 fingerprint of the focused window metadata. It uses Accessibility when available and otherwise falls back to the opaque Core Graphics window number. The window title itself never leaves the helper.
- `active-target clipboard-sequence` returns `NSPasteboard.changeCount` so LocalScribe restores the clipboard only when no other process changed it.
- `active-target paste darwin <pid> <application-id> <window-fingerprint> <focused-element-fingerprint> <clipboard-sequence>` recaptures the exact active window and editable Accessibility element, then posts Command-V only when both identities and the clipboard sequence match the target and transcription written by LocalScribe. It never receives transcript or clipboard content.
- `active-target accessibility-status` and `active-target request-accessibility` report or request the macOS event-posting permission used by automatic paste.
- `active-target hold-monitor <canonical-shortcut>` polls the combined-session key-state table and emits only hold down/up or generic modified-input events. It never emits key identities or typed content. Common macOS keys and arbitrary modifier chords use this narrow permission-free path instead of installing a session-wide event tap; PC-only keys without macOS virtual-key codes retain the legacy Accessibility path. Accessibility is still required for automatic paste injection.
- `active-target self-test` validates the target- and clipboard-bound paste argument parser and matcher without injecting input.

Build it during packaging, before Electron signing:

```sh
xcrun swiftc -O -target arm64-apple-macos13.0 resources/native/macos/active-target.swift \
  -o resources/native/macos/active-target
```

The generated binary must be placed at `Contents/Resources/native/macos/active-target` and signed as nested code. `src/main/nativeHelperPath.ts` resolves this same helper for insertion and the Control monitor: it prefers the packaged signed binary, then the source-tree binary during development. Development may instead set `LOCALSCRIBE_NATIVE_INSERTION_HELPER` to an absolute compiled-helper path; that explicit override is shared by both consumers only when the main-process caller explicitly enables development overrides. Packaged callers never accept it and use the bundled signed helper.
