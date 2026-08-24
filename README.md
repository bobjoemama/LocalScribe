# LocalScribe

LocalScribe is a local-first dictation app for Apple Silicon Macs: microphone
audio is transcribed on the Mac without a transcription account, cloud API,
telemetry service, hidden network fallback, or listening network port.

## Current release boundary

LocalScribe currently produces **macOS arm64 validation builds** for macOS 14
or newer. A validation DMG or ZIP may be signed with Apple Development or an
ad-hoc identity and is not proof of Developer ID signing, notarization, or
public Gatekeeper acceptance. Repository availability and source licensing do
not change that binary trust boundary.

Use the newest approved asset from the repository's GitHub Releases page. Do
not replace or overwrite an existing release asset: every build must have a
new version and tag. Verify the downloaded DMG against the matching
`SHA256SUMS.txt` before opening it:

```sh
cd /path/to/downloaded/assets
shasum -a 256 -c LocalScribe-<version>-macos-arm64-SHA256SUMS.txt
```

The verification is successful only when every listed asset reports `OK`.
Keep the checksum file and artifacts from the same release; a digest printed by
`shasum` is not useful unless it is compared with that release's manifest.

If macOS refuses to open a validation build, do not disable system-wide
security protections. Build from source or use an artifact that has passed the
appropriate Apple signing and notarization gates.

## Install and configure

1. Open the DMG and drag **LocalScribe** into **Applications**.
2. Open LocalScribe and allow **Microphone** access.
3. Allow **Accessibility** access if you want automatic insertion into the
   previously focused text field. Without it, LocalScribe can use copy-only
   fallback.
4. Open **Settings -> Model & Performance**.
5. Select a model family and performance mode. The choice remains pending
   until **Apply model** is pressed.
6. Explicitly install the selected model if its exact artifact is not already
   verified, then press **Apply model** and wait for **ready**.
7. Dictate with the shortcut displayed by LocalScribe. The persisted shortcut
   is the source of truth for both behavior and labels.

Selecting or downloading a model does not make it active. Apply verifies the
exact target before unloading a working model, keeps only one large runtime
resident, and commits the new selection only after the target loads. A failed
switch preserves the previous committed selection. Normal dictation never
downloads a model and never silently substitutes another model.

## Dictation modes

- **After I stop** records first, then transcribes and inserts one final result.
- **Live** shows incremental partial text and inserts only the final result.

Parakeet Unified EN 0.6B is the recommended fresh-install family. It supports
English after-stop and Live dictation through pinned FluidAudio/Core ML assets:

| Performance choice | Parakeet profile | Precision |
| --- | --- | --- |
| Auto | Highest installed Parakeet profile that fits | High or Medium |
| High | Core ML FP16 | Original, unquantized precision |
| Medium | Core ML INT8 | Quantized |
| Low | Not offered | Parakeet has no Q4/Low artifact |

Auto stays within the user-selected family. Other curated macOS families may
offer High, Medium, and Low profiles through pinned MLX artifacts; their
availability does not change Parakeet's two-profile contract. See the
[model catalog](docs/MODEL_CATALOG.md).

## Local data and privacy

The following remain on the Mac:

- audio transcription and model inference;
- dictionary, snippets, notes, settings, and history;
- the SQLite database at
  `~/Library/Application Support/LocalScribe/localscribe.db`;
- model artifacts under LocalScribe's application-support directory.

Sensitive text is protected with the macOS keystore. Raw audio is held in
memory; after-stop dictation is staged in a user-only temporary WAV for
inference. LocalScribe attempts to remove each staged file after use, removes
its process-owned temporary directory on orderly quit, and removes stale
LocalScribe audio directories at the next launch. A cleanup failure is recorded
rather than falsely turning a successful dictation into a failure. Transcript
deletion uses SQLite `secure_delete` so freed database pages are overwritten
rather than waiting for later reuse. See the [privacy boundary](docs/PRIVACY.md)
for the exact data and cleanup contract.

LocalScribe accepts only revision-pinned catalog artifacts with declared byte
sizes and SHA-256 hashes. It does not accept arbitrary model URLs, executable
model plugins, custom loaders, cloud inference, or remote prompts.

## Build and verify from source

Requirements:

- Apple Silicon Mac;
- macOS 14 or newer;
- Xcode command-line tools;
- the exact Node, npm, and `uv` versions pinned by `.nvmrc`, `package.json`,
  and `.uv-version`. The worker Python version, Python distribution, npm and
  Python dependency graphs, and FluidAudio release are also pinned in the
  repository. Xcode and the Swift compiler remain host-toolchain inputs.

Install and run the source gates:

```sh
npm ci --strict-allow-scripts
npm run verify:local
```

Do not substitute `npm install` or an unlocked `uv sync` when validating a
candidate. `npm ci` consumes `package-lock.json`; the verification pipeline
checks the npm and `uv` pins plus both dependency locks before running audits,
lint, type checking, and tests.

Build and verify the macOS candidate:

```sh
npm run verify:local:macos
```

To include repeated inference with an already installed Parakeet artifact and
a 16 kHz mono PCM16 fixture:

```sh
npm run verify:local:macos -- \
  --smoke-model-root "$HOME/Library/Application Support/LocalScribe/models" \
  --smoke-audio /absolute/path/to/fixture.wav \
  --smoke-family parakeet-unified-en-0-6b --smoke-tier medium \
  --smoke-mode both --smoke-repeat 2
```

The packaged smoke resolves its Python runtime, worker, manifests, and native
helper only from the new candidate. Downloads are disabled unless explicitly
enabled, and the local-only path does not repair or mutate the user model
cache. Outputs are written under `out/`.

Source and packaged gates do not prove physical microphone capture, global
shortcuts, third-party focus/paste behavior, clean-account permissions,
notarization, or public binary distribution. Those require separate acceptance
evidence on the exact artifact.

LocalScribe is a native macOS desktop application, not a container service.
Docker Compose cannot run or validate macOS TCC microphone/Accessibility
consent, global shortcuts, third-party focus and paste, Core ML/ANE execution,
codesigning, or DMG installation. A container may run some source-only tooling,
but that output is not a macOS application acceptance result. Use the
[coworker testing runbook](docs/COWORKER_TESTING.md) for a checksummed native
candidate and an explicit physical-test boundary.

## Documentation

| Document | Purpose |
| --- | --- |
| [Model catalog](docs/MODEL_CATALOG.md) | Model families, modes, revisions, precision, and licenses |
| [Packaging policy](docs/PACKAGING.md) | Files allowed inside a macOS artifact and the package gates |
| [Release procedure](docs/RELEASING.md) | Local verification, validation builds, and GitHub staging |
| [Audio protocol](docs/AUDIO_PROTOCOL.md) | Renderer-to-worker audio contract |
| [Clean-room policy](docs/CLEAN_ROOM.md) | Product independence and dependency provenance |
| [Privacy boundary](docs/PRIVACY.md) | Local data, network, encryption, audio, and deletion behavior |
| [Coworker testing](docs/COWORKER_TESTING.md) | Checksummed native install and physical macOS acceptance |
| [Delivery plan](docs/DELIVERY_PLAN.md) | Remaining macOS implementation and acceptance work |

## Security status

- The Electron renderer is sandboxed with context isolation and no Node
  integration.
- IPC inputs and renderer permissions are allowlisted.
- Electron fuses, ASAR provenance, loose-resource integrity, entitlements,
  signatures, SBOMs, and checksums are verified from the candidate artifact.
- Generated runtimes, model weights, installers, credentials, and build output
  are not committed.
- Local verification does not automatically publish a GitHub Release or update
  feed.

## License

LocalScribe is licensed under the
[Apache License 2.0](LICENSE). The copyright and attribution notice is in
[NOTICE](NOTICE).
Third-party components retain their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
