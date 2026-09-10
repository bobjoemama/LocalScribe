# Model comparison and download sources

Reviewed 9 September 2026. Settings → Model & Performance offers stable ascending
and descending sorting by estimated memory, download size, reference WER, and
reference speed. Sorting is a browsing preference; it never selects, installs,
loads, or applies a model. Missing values remain last in either direction.

## What the numbers mean

- **Memory:** the upper endpoint of LocalScribe's existing per-profile estimate
  from `src/main/modelSpec.ts`. This is Apple Silicon unified memory, not dedicated
  VRAM, measured RSS, or a guarantee that a recording fits. Online weight sizes
  cannot establish runtime peak memory. These estimates are not online benchmarks.
- **Download:** exact curated manifest file bytes, not memory usage. The comparison
  profile is independent of the pending performance setting. Parakeet has no Low
  profile; no substitute is used. Auto still resolves through the normal runtime
  policy, not through sorting.
- **Reference WER and speed:** the `LS Clean WER` and `LS Clean RTFx` columns in
  [Hugging Face's pinned Open ASR results](https://huggingface.co/datasets/hf-audio/open-asr-leaderboard-results/blob/ba5712d5ace8f785fa0daae1aecea8561ecd87c9/english_short_latest.csv).
  This is an English LibriSpeech test-clean reference, not multilingual dictation
  quality, LocalScribe measurements, Mac performance, or quantization-specific
  evidence. RTFx is audio duration divided by processing time; higher is faster.
  The [leaderboard methodology](https://github.com/huggingface/open_asr_leaderboard#evaluate-a-model-as-of-24-july-2026)
  specifies NVIDIA H200 jobs with per-family runtimes. Those runtimes and batching
  differ from this app; this is not a forecast for your Mac.

| Reference checkpoint | WER (%) | RTFx |
| --- | ---: | ---: |
| NVIDIA Canary-Qwen 2.5B | 1.23 | 678.3482 |
| Qwen3-ASR 1.7B **-hf** | 1.26 | 664.199 |
| Whisper large-v3 | 1.56 | 485.126 |
| Qwen3-ASR 0.6B **-hf** | 1.70 | 723.1457 |

The Qwen entries are the Transformers reference checkpoints, **not** the MLX
artifacts. Parakeet **Unified** and Whisper large-v2 are absent from this snapshot;
they remain unreported rather than borrowing another variant's results. All Live
reference metrics are unreported because this dataset measures after-stop runs.

Additional primary sources were reviewed, but deliberately not mixed into that
sort: [NVIDIA's Unified model card](https://huggingface.co/nvidia/parakeet-unified-en-0.6b),
[Qwen's evaluation](https://huggingface.co/Qwen/Qwen3-ASR-1.7B#evaluation),
[FluidAudio's Apple Silicon benchmarks](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Benchmarks.md),
and [transcribe.cpp's Canary measurements](https://github.com/handy-computer/transcribe.cpp/blob/main/docs/models/canary-qwen-2.5b.md).
The latter two contain useful Mac measurements, but not a matched set covering
our six families, precisions, runtime versions, hardware, and workloads. We do
not rank an M5 Pro full-corpus result against an M4 Max short-clip result.

## Artifact provenance

All downloads use the canonical Hugging Face Hub, immutable 40-character commit
revisions, explicit file allowlists, and local SHA-256 verification before atomic
installation. Normal inference remains offline. The worker explicitly sets the
Hub endpoint; ambient mirror configuration cannot redirect the intended origin.
Hugging Face may deliver large files through its own CDN/Xet infrastructure.

| Family | Original publisher page | Actual Mac artifact publisher |
| --- | --- | --- |
| Parakeet Unified | [NVIDIA](https://huggingface.co/nvidia/parakeet-unified-en-0.6b) | [FluidInference](https://huggingface.co/FluidInference/parakeet-unified-en-0.6b-coreml), Core ML |
| Canary-Qwen | [NVIDIA](https://huggingface.co/nvidia/canary-qwen-2.5b) | [handy-computer](https://huggingface.co/handy-computer/canary-qwen-2.5b-gguf), GGUF |
| Qwen3-ASR 0.6B | [Qwen](https://huggingface.co/Qwen/Qwen3-ASR-0.6B) | MLX Community, separate BF16/INT8/INT4 repositories |
| Qwen3-ASR 1.7B | [Qwen](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) | MLX Community, separate BF16/INT8/INT4 repositories |
| Whisper large-v3 | [OpenAI](https://huggingface.co/openai/whisper-large-v3) | MLX Community, separate FP16/INT8/INT4 repositories |
| Whisper large-v2 | [OpenAI](https://huggingface.co/openai/whisper-large-v2) | MLX Community, separate FP16/INT8/INT4 repositories |

Runtime-maintainer/community conversions are **not original-publisher artifacts**.
Replacing them with raw original checkpoints would require different runtimes;
the application does not silently substitute models. Exact per-profile pinned
URLs are available under each card's **Metrics & download sources**, with a copy
button. No new renderer permission to open arbitrary URLs was introduced.
Artifact licenses remain their existing declarations; an upstream license is not
silently assigned to an artifact with undeclared metadata.

## Repeatable verification

`npm run audit:model-sources` reads canonical Hub metadata for every manifest,
checks publisher/revision identity, file byte counts and published LFS SHA-256
digests, and hashes bounded small non-weight Git files. It also verifies original
model page identities and the exact pinned benchmark columns and values. No
model weights are downloaded; this is provenance verification, not an inference
or safety certification of the weights. It is opt-in and is not run by the app.

Unit tests cover both sort directions, ties, missing data, real catalog coverage,
profile availability, Live filtering, source validation, and failed audits. The
headless Settings layout harness exercises the controls, verifies ordering,
checks expanded source details at supported sizes, and checks that comparison
controls do not invoke Apply/settings writes.
