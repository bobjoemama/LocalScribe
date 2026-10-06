# LocalScribe

Private dictation for your Mac. Speak naturally, then insert the transcript
into the app you were using. Speech recognition runs locally—no subscription,
cloud transcription, or telemetry.

**Apple Silicon Mac (M1 or newer) · macOS 14 or newer**

## Download and install

### [Download LocalScribe for Mac](https://github.com/bobjoemama/LocalScribe/releases/download/v0.1.0-dev.20/LocalScribe-0.1.0-dev.20-arm64.dmg)

**Distribution status:** [dev.20 is a published prerelease](https://github.com/bobjoemama/LocalScribe/releases/tag/v0.1.0-dev.20),
Developer ID-signed and Apple-notarized.
It remains a validation build; hands-on checks and known limitations are listed
in the release notes. Older previews may not be notarized.
If macOS blocks a download, stop and report the message rather than disabling
security protections.

1. Use **Download LocalScribe for Mac** above, or open the release page and
   download the **`-arm64.dmg`** from **Assets**. You do not need the source-code ZIP or TAR files.
2. Open the DMG and drag **LocalScribe** into **Applications**.
3. Open LocalScribe from Applications. Allow **Microphone** access to dictate
   and **Accessibility** access if you want automatic text insertion.
4. In **Settings → Model & Performance**, choose a model and download its
   files. **Parakeet Unified EN 0.6B** is the recommended English starting point.
   Press **Apply model** and wait until it is ready.
5. Click a text field in another app and use the hold-to-talk or toggle
   shortcut shown in LocalScribe. Shortcuts are configurable in Settings.

Internet access is needed to download the app and your chosen model. Once the
model is installed, dictation works offline. Downloading a model does not
activate it until you press Apply. **Download all** installs all 14 offered
profiles and adds all six families to your library; only the applied model is
loaded in memory.

## iOS

The native iPhone app and keyboard are in [LocalScribeiOS](https://github.com/bobjoemama/LocalScribeiOS). The catalog includes Phonon 2 LUT6 CPU/ANE, Phonon 2 LUT3 GPU, and Moonshine Small Streaming CPU. They run locally; physical-device performance and keyboard validation are still in progress.

## What you can do

- **After I stop:** record, then transcribe and insert the finished text.
- **Live:** read an updating transcript as you speak; insert the final text
  when you stop. Availability depends on the selected model.
- **Dictionary:** correct names, technical terms, and recurring phrases.
- **Snippets:** expand a spoken trigger into saved text.
- **Cleanup and transforms:** apply deterministic cleanup and exact rules.
- **History and scratchpad:** keep encrypted local transcripts and notes.
- **Copy fallback:** copy the result when automatic insertion is unavailable.

The Mac catalog offers six families and 14 profiles: Parakeet Unified,
Qwen3-ASR 0.6B and 1.7B, Canary-Qwen, Phonon 2, and Moonshine Small Streaming.
Phonon offers **Neural Engine / LUT6** (CPU/ANE encoder) and **GPU / LUT3**
(CPU/GPU encoder); it requires **macOS 15 or newer**. Moonshine offers one
**CPU** runtime. Both support English Live and after-stop dictation. Phonon
Live uses sliding windows; Moonshine uses its streaming architecture.
Language support, download sizes, and memory estimates appear in Settings.
Canary-Qwen is English-only and **After I stop** only.
Whisper is no longer supported. An older saved Whisper selection stays
unavailable until you choose and Apply a supported replacement; cached model
files and history are preserved, and the app never silently switches families.
See the [model catalog](docs/MODEL_CATALOG.md) for details.

## Included—no dependency setup required

The DMG includes the application and its required runtimes:

- Electron and the JavaScript runtime, UI, database, and shortcut dependencies.
- A private Python 3.12.13 runtime with the locked MLX inference dependencies.
- FluidAudio/Core ML integration, Moonshine/ONNX Runtime, the Canary Metal
  runtime, and native macOS insertion helpers.
- Dependency licenses and attributions; release assets include dependency
  inventories (SBOMs) and checksums.

**You do not need Docker, Python, Node.js, Homebrew, Xcode, or a terminal to
install and use the app.** Existing system Python or Node versions are not used.
Core ML and Metal are provided by macOS.

**Not included:** large speech-model weights. Download only the models and
profiles you want from Settings, or use **Download all**; sizes are shown
before downloading. Installed files occupy disk space independently of the
single applied model kept loaded.
Normal dictation never downloads a model or silently switches to another one.

## Updating and troubleshooting

- **Update:** quit LocalScribe, download the new DMG, and replace the app in
  Applications. Updates are manual; your settings, history, and downloaded
  models remain in place.
- **Text does not insert:** check Microphone and Accessibility in **System
  Settings → Privacy & Security**, and use a normal editable text field.
  Copy the transcript if the target app does not support insertion.
- **Upgrading an older development build:** a change in signing identity may
  require granting Accessibility access again for the newly installed app.
- **Remove the app:** quit it and move LocalScribe from Applications to Trash.
  This does not delete your saved data or downloaded models.

## Local text models and privacy

Speech models transcribe audio; they are not general-purpose writing models.
LocalScribe does **not** currently connect to Ollama, LM Studio, or other local
text-model servers. Running one separately does not enable rewriting,
translation, or summarization. Those features require a future integration;
today's Dictionary, Snippets, cleanup, and transforms are deterministic.

Audio and text are processed on your Mac. There are no cloud inference calls,
accounts inside the app, remote prompts, telemetry, or listening network ports.
See [Privacy](docs/PRIVACY.md) for storage, encryption, and audio cleanup details.

<details>
<summary>Optional: verify downloaded files</summary>

Download the release's `SHA256SUMS.txt` and all four files it names (DMG, ZIP,
and two SBOMs) into one folder. In Terminal, open that folder and run the command
below, replacing `<version>` with the downloaded version. Every line must say
`OK`.

```sh
shasum -a 256 -c LocalScribe-<version>-macos-arm64-SHA256SUMS.txt
```

Checksums verify file integrity; they do not replace Apple signing or
notarization. Do not replace or overwrite an existing release asset:
every build must have a new version and tag.

</details>

## Build and verify from source

This section is for developers, not required for installation. Build
requirements and commands are in [Releasing](docs/RELEASING.md); dependency
locks pin the toolchain and runtime. See [Packaging](docs/PACKAGING.md) and the
[coworker test checklist](docs/COWORKER_TESTING.md) for verification boundaries.

## License

[Apache License 2.0](LICENSE). Dependencies and downloaded models retain their
own licenses; see [NOTICE](NOTICE) and [third-party notices](THIRD_PARTY_NOTICES.md).
