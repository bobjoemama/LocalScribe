# Clean-room product reference policy

LocalScribe may reproduce publicly observable dictation workflows, but it does not copy Wispr Flow source code, private APIs, product assets, icons, wording, or exact trade dress.

OpenWhispr was reviewed as a frozen MIT-licensed architectural reference. The current LocalScribe source was written as a smaller TypeScript implementation and does not contain copied OpenWhispr files. If future work copies or adapts MIT source, the originating copyright and license notice must be added to the file and `THIRD_PARTY_NOTICES.md`.

Every model, runtime, native module, and packaged binary must be audited under
its own license before distribution. The macOS large-v3 FP16 manifest and the
Windows Systran faster-whisper large-v3 and large-v2 manifests declare MIT.
The pinned macOS large-v3 8-bit and 4-bit artifacts and the macOS
`mlx-community/whisper-large-v2-mlx` family have `Undeclared` license metadata;
they need distribution review and must not be treated as MIT by inference. All
selected identities and per-file digests are recorded in
`resources/model-manifest/`; see [MODEL_CATALOG.md](MODEL_CATALOG.md).

The curated Qwen3-ASR model manifests declare Apache-2.0. Windows Qwen
inference additionally ships a narrowly retained CrispASR 0.8.24 CUDA runtime:
the release archive, each retained DLL, its MIT license, and its
third-party notices are pinned by digest in
`resources/native/windows/crispasr-runtime.json`. This approval does not extend
to arbitrary Qwen repositories, GGUF conversions, or native runtime releases.
