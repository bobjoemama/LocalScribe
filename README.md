# LocalScribe

Private dictation for your Mac. Speak, then insert the finished text into the
app you were using. Speech recognition runs on your Mac, without an account,
subscription, cloud transcription, or telemetry.

**Apple Silicon Mac (M1 or newer) · macOS 14 or newer**

## Download and install

### [Download the older dev.20 preview for Mac](https://github.com/bobjoemama/LocalScribe/releases/download/v0.1.0-dev.20/LocalScribe-0.1.0-dev.20-arm64.dmg)

The latest public DMG is [dev.20](https://github.com/bobjoemama/LocalScribe/releases/tag/v0.1.0-dev.20),
a Developer ID-signed, Apple-notarized prerelease with the older interface.
The redesigned dev.21 interface described below does not have a public DMG yet.

1. Download the **`-arm64.dmg`** app installer. The source-code ZIP and TAR
   files are for developers.
2. Open the DMG and drag **LocalScribe** into **Applications**.
3. Open LocalScribe from Applications. Grant **Microphone** access for
   recording and **Accessibility** access for automatic text insertion.
4. In dev.20, open **Settings → Model & Performance**. In the current source
   build, open **Models**. Choose a model and download its files. **Parakeet Unified EN 0.6B** is a good English starting point.
   Click **Apply model** (or **Load current model**) and wait for **Applied and ready**.
5. Click an editable text field in another app, then use the hold or toggle
   shortcut shown in LocalScribe.

The app includes its runtimes. You do not need to install Python, Docker,
Node.js, Homebrew, Xcode, or use Terminal. Large speech-model files are
downloaded separately; their sizes are shown before downloading. Once your
model is downloaded, dictation works offline.

## Use LocalScribe

- **Hold to talk:** hold your configured shortcut while speaking, then release
  it to finish. The fresh-install default is **Control**.
- **Toggle dictation:** press your configured shortcut to start, then again to
  finish. The fresh-install default is **Control + Space**.
- **After I stop:** transcribe the recording after you finish speaking.
- **Live:** preview an updating transcript while speaking; insert the finished
  text after stopping. Choose a model that supports Live in **Models**.

Shortcuts, microphone, automatic insertion, and **Appearance** are configurable
in **Settings**. Your saved shortcuts take precedence over the defaults.

- **Dictation / History:** find, copy, or delete your saved transcripts.
- **Dictionary:** correct recurring names, terms, and phrases.
- **Snippets:** expand a spoken trigger into saved text.
- **Cleanup:** remove fillers, handle spoken punctuation, and apply exact rules.
- **Notes:** write and save local notes.

## Models and privacy

Choose models and profiles in **Models**. Downloading files does not activate
them: apply your selection to load it. **Download all** installs the offered
profiles on disk; only the applied model is loaded in memory.

The catalog includes Parakeet Unified, Qwen3-ASR, Canary-Qwen, Phonon 2, and
Moonshine Small Streaming. Phonon requires **macOS 15 or newer**. Languages,
Live support, download sizes, and memory estimates vary by model; see the
[model catalog](docs/MODEL_CATALOG.md).

Audio and text are processed locally. History and notes use encrypted local
storage. See [Privacy](docs/PRIVACY.md) for retention and audio cleanup details.

## Updates and troubleshooting

- **Update:** quit LocalScribe, install the newer DMG, and replace the app in
  Applications. Settings, history, notes, and downloaded models stay in place.
- **Recording or insertion fails:** check **System Settings → Privacy &
  Security → Microphone / Accessibility**. Copy the transcript if the target
  app cannot accept insertion. A signing change may require renewed permission.
- **Model unavailable:** choose, download, and apply a supported model. An
  older saved Whisper selection needs an explicit replacement.
- **Limits:** these are prerelease builds. LocalScribe has no Ollama or LM
  Studio integration; Cleanup uses deterministic rules rather than a text model.
- **Uninstall:** quit and move the app to Trash. Saved data and model files remain.

For optional integrity verification, download the release's checksum manifest
and every file it lists into one folder, then run:

```sh
shasum -a 256 -c LocalScribe-<version>-macos-arm64-SHA256SUMS.txt
```

Each line should say `OK`. See the release notes for build-specific limitations.

## Developers, iOS, and license

[Build and verify from source](docs/RELEASING.md) · [Packaging](docs/PACKAGING.md)
· [iPhone app and keyboard](https://github.com/bobjoemama/LocalScribeiOS)

[Apache License 2.0](LICENSE). Dependencies and models retain their own licenses;
see [NOTICE](NOTICE) and [third-party notices](THIRD_PARTY_NOTICES.md).
