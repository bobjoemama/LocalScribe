# Clean-room product reference policy

LocalScribe may reproduce publicly observable dictation workflows, but it does
not copy Wispr Flow source, private APIs, trademarks, product assets, icons,
wording, advertising, or exact trade dress.

OpenWhispr was reviewed as a frozen MIT-licensed architectural reference. The
LocalScribe implementation was written independently in TypeScript and does
not contain copied OpenWhispr files. If future work copies or adapts MIT source,
the originating copyright and license notice must be added to that file and to
`THIRD_PARTY_NOTICES.md`.

Every model, runtime, native module, and packaged binary requires its own exact
license review before distribution. A related repository or runtime license
must never be inferred to cover a different pinned artifact.

Current macOS boundaries:

- the Parakeet Unified Core ML artifact declares CC-BY-4.0 at its pinned
  revision;
- FluidAudio declares Apache-2.0, which does not replace Parakeet attribution;
- the Whisper large-v3 FP16 manifest declares MIT;
- pinned Whisper large-v3 8-bit/4-bit and all pinned
  `mlx-community/whisper-large-v2-mlx` artifacts have `Undeclared` license
  metadata and require separate distribution review;
- curated Qwen3-ASR manifests declare Apache-2.0.

Exact identities, revisions, sizes, and file digests are recorded in
`resources/model-manifest/`; see [MODEL_CATALOG.md](MODEL_CATALOG.md). License
approval for one manifest does not authorize arbitrary repositories,
conversions, URLs, plugins, or native runtime releases.
