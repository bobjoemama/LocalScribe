# LocalScribe

An open-source alternative to Wispr Flow. Dictate into Mac apps with speech
models that run locally—no account, subscription, telemetry, or cloud transcription.

**Apple Silicon Mac · macOS 14+** (Phonon requires macOS 15+).

## Install and dictate

### [Download LocalScribe for Mac — dev.24](https://github.com/bobjoemama/LocalScribe/releases/download/v0.1.0-dev.24/LocalScribe-0.1.0-dev.24-arm64.dmg)

Latest public download: [dev.24](https://github.com/bobjoemama/LocalScribe/releases/tag/v0.1.0-dev.24),
a Developer ID-signed, Apple-notarized prerelease (redesigned interface).

1. Open the downloaded DMG and drag **LocalScribe** into **Applications**.
2. Open LocalScribe. Grant **Microphone** access for recording and
   **Accessibility** access for automatic text insertion.
3. Open **Models**. Choose a model and download its
   files; **Parakeet Unified EN 0.6B** is a good English starting point.
   Click **Apply model** (or **Load current model**) and wait until ready.
4. Click a text field in another app. Press your toggle shortcut to start,
   then again to finish. The default is **Control + Space**.

You can also hold your hold-to-talk shortcut while speaking; its default is
**Control**. Use the shortcuts shown in Settings if you have saved different ones.

The app includes its runtimes. You do not need to install Python, Docker,
Node.js, Homebrew, Xcode, or use Terminal. Large speech-model files are
downloaded separately. Downloading does not activate a model; apply it to load it.
Once downloaded, dictation works offline.

Live previews, Dictionary, Snippets, Cleanup, History, Notes, and appearance
settings are built in. If insertion fails, check macOS **Privacy & Security**
permissions or copy the transcript. To update, quit and replace the app in
Applications; your data and downloaded models stay in place.

[iPhone app and keyboard](https://github.com/bobjoemama/LocalScribeiOS)

## Advanced

[Models](docs/MODEL_CATALOG.md) · [Privacy](docs/PRIVACY.md) ·
[Build and verify from source](docs/RELEASING.md) · [Packaging](docs/PACKAGING.md)

Optional verification: download the checksum manifest from the
[release notes and checksums](https://github.com/bobjoemama/LocalScribe/releases/tag/v0.1.0-dev.24)
and every file it lists into one folder. Run
`shasum -a 256 -c LocalScribe-<version>-macos-arm64-SHA256SUMS.txt`;
each line should say `OK`.

[Apache License 2.0](LICENSE) · [NOTICE](NOTICE) · [Third-party licenses](THIRD_PARTY_NOTICES.md)
