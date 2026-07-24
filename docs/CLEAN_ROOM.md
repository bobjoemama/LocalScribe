# Clean-room product reference policy

LocalScribe may reproduce publicly observable dictation workflows, but it does not copy Wispr Flow source code, private APIs, product assets, icons, wording, or exact trade dress.

OpenWhispr was reviewed as a frozen MIT-licensed architectural reference. The current LocalScribe source was written as a smaller TypeScript implementation and does not contain copied OpenWhispr files. If future work copies or adapts MIT source, the originating copyright and license notice must be added to the file and `THIRD_PARTY_NOTICES.md`.

Every model, runtime, native module, and packaged binary must be audited under
its own license before distribution. The macOS large-v3 manifests and the
Windows Systran faster-whisper large-v3 and large-v2 manifests declare MIT.
The macOS
`mlx-community/whisper-large-v2-mlx` family has `Undeclared` license metadata
in its pinned manifests; that artifact needs distribution review and must not
be treated as MIT by inference. All selected identities and per-file digests
are recorded in `resources/model-manifest/`; see [MODEL_CATALOG.md](MODEL_CATALOG.md).
