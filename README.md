# LocalScribe

LocalScribe is a local-first dictation app for Apple Silicon Macs. It
records your microphone, transcribes speech on the Mac, and inserts the result
into the app you were using—without a transcription account, cloud API,
telemetry, hidden network fallback, or listening network port.

## What it does

- **After I stop:** record first, then transcribe and insert one final result.
- **Live:** show an updating transcript while you speak, then insert one final
  result.
- Use configurable hold-to-talk and toggle shortcuts.
- Correct names and phrases with Dictionary entries.
- Expand spoken triggers with Snippets.
- Apply deterministic cleanup and exact text transforms.
- Save encrypted local history and scratchpad notes when enabled.
- Fall back to copying the transcript when safe automatic insertion is not
  available.

LocalScribe uses curated, revision-pinned speech models. Parakeet Unified EN
0.6B is the recommended English model and runs through FluidAudio and Core ML.
Its High profile is FP16 original precision and Medium is INT8; Parakeet has no
Low/Q4 profile. Other curated MLX-based Whisper and Qwen profiles are available
for different language, quality, and memory requirements.

## Download and install

LocalScribe supports Apple Silicon and macOS 14 or newer.

1. Download the newest approved DMG and matching `SHA256SUMS.txt` from the
   [GitHub Releases page](https://github.com/bobjoemama/LocalScribe/releases).
2. Keep every file named by the checksum manifest in one directory and verify
   them before opening the DMG:

   ```sh
   shasum -a 256 -c LocalScribe-<version>-macos-arm64-SHA256SUMS.txt
   ```

3. Open the DMG and drag **LocalScribe** into **Applications**.
4. Allow Microphone access. Allow Accessibility access only if you want
   automatic insertion into the previously focused text field.
5. Choose and explicitly install a model in **Settings -> Model & Performance**,
   then press **Apply model** and wait for **ready**.

Current binaries are private validation builds. They may use Apple Development
or ad-hoc signing and are not claimed to be Developer ID notarized or accepted
by Gatekeeper on every Mac. Do not weaken macOS security settings to open a
blocked build.

The repository is currently private. A tester must be invited to the GitHub
repository before the Releases link or its assets will be accessible. Send the
tester the [coworker validation runbook](docs/COWORKER_TESTING.md) with the
release link.

Do not replace or overwrite an existing release asset. Every build must have a
new version and tag so its source, checksums, and packaged bytes remain
traceable.

## Speech models and local text models

The included integrations are speech-recognition models: they convert audio to
text. LocalScribe does not currently connect to Ollama, LM Studio, or another
local generative text model, so merely running one does not change dictation.

A future, explicit local text-model integration could add semantic rewriting,
tone changes, translation, summarization, or command interpretation. Those
features are visibly unavailable today; Dictionary, Snippets, cleanup, and
exact transforms remain deterministic and local.

Model selection is fail-closed: downloading does not activate a model, Apply
verifies the exact target before switching, normal dictation never downloads,
and LocalScribe never silently substitutes another family or profile.

## Privacy

- Audio transcription and model inference stay on the Mac.
- Settings, Dictionary, Snippets, notes, and optional history are stored
  locally; sensitive text uses the macOS keystore.
- Raw audio is held in memory or in a user-only temporary file needed for
  after-stop inference, then scheduled for deletion.
- Model downloads accept only curated revisions with declared sizes and
  SHA-256 hashes.
- There are no accounts, cloud inference calls, remote prompts, arbitrary model
  URLs, executable model plugins, or telemetry.

See [docs/PRIVACY.md](docs/PRIVACY.md) for the exact storage and cleanup
boundary.

## Build and verify from source

Requirements: Apple Silicon, macOS 14+, Xcode command-line tools, and the exact
Node, npm, `uv`, and Python versions pinned by the repository.

```sh
npm ci --strict-allow-scripts
npm run verify:local
npm run verify:local:macos -- --release-candidate --require-accessibility
```

The macOS gate builds DMG and ZIP candidates under `out/`, verifies their
contents, signatures, entitlements, provenance, SBOMs, and checksums, and runs
the packaged worker and cold-editor recovery tests. The explicit Accessibility
flag makes a missing local TCC grant fail instead of silently skipping that
machine-only test. Release-candidate mode also requires every provenance input
to be committed in a clean Git worktree; ordinary pre-commit source checks
continue to allow intended tracked edits. Generated dependencies, runtimes,
model files, credentials, and build output are excluded from Git.

Automated gates do not prove physical microphone permissions, global shortcuts,
third-party focus/paste behavior, or clean-account Gatekeeper behavior. Use the
[coworker validation runbook](docs/COWORKER_TESTING.md) for those checks.

LocalScribe is a native macOS application, not a container service. Docker
Compose cannot validate macOS Microphone/Accessibility consent, global input
hooks, Core ML/ANE execution, signing, or DMG installation.

## Project documentation

- [Model catalog](docs/MODEL_CATALOG.md)
- [Packaging policy](docs/PACKAGING.md)
- [Release procedure](docs/RELEASING.md)
- [Privacy boundary](docs/PRIVACY.md)
- [Coworker testing](docs/COWORKER_TESTING.md)
- [Clean-room policy](docs/CLEAN_ROOM.md)

## License

LocalScribe is licensed under the [Apache License 2.0](LICENSE). See
[NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for
copyright and third-party attribution.
