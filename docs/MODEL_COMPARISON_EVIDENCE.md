# Model comparison and download sources

## Accuracy-first research — 16 October 2026

Devesh requested a better Mac model/runtime than Canary-Qwen, prioritizing
word error rate, then speed, then memory. Two independent GPT-6.1-Sol research
shares inspected primary model evidence and the Canary integration. Research
is complete; model additions, runtime updates and benchmarks remain proposed.
The running Mac app, model selection and Control–Space were unchanged.

| Candidate | Current seven-set WER (%) | Practical role |
| --- | ---: | --- |
| Qwen3-ASR 1.7B-hf | 5.746 | First accuracy challenger; MLX already integrated |
| Cohere Transcribe 03-2026, 2B | 6.263 | New balanced accuracy/speed challenger |
| Canary-Qwen 2.5B | 6.369 | Existing baseline |
| Granite Speech 4.1 2B | 6.421 | Keyword biasing/punctuation; MLX or Metal |
| Granite Speech 4.1 2B NAR | 6.450 | Non-autoregressive alternative |
| Qwen3-ASR 0.6B-hf | 6.603 | Existing smaller baseline |
| Granite Speech 5.0 TurboCTC 470M | 6.837 | Size/speed candidate; no broad accuracy win |

Source: [HF results at fc33fde](https://huggingface.co/datasets/hf-audio/open-asr-leaderboard-results/blob/fc33fde2e2b5d462ab60599c572094672d99913a/english_short_latest.csv).
The orchestrator fetched and recomputed the Qwen 1.7B, Cohere, Canary and three
Granite averages from the same seven columns: AMI-Cleaned,
Earnings22-Cleaned-AA-chunked, Gigaspeech-Cleaned, SPGISpeech, URGENT2024,
Voice Arena Monsoon and Voxpopuli-AA-Cleaned. LibriSpeech is excluded.
These averages differ from older eight-set launch averages (including Canary
5.63%). H200 reference speed is not Mac speed; checkpoint WER does not establish
Mac conversion or personal-dictation accuracy.

Other screened candidates: MOSS Transcribe Diarize 0.9B (6.287, MLX available),
ARK-ASR-0.6B (1.15B total, 6.291), Higgs v3 STT (6.190; score predates refreshed
weights), Hojo ASR V1 (5.18B, 6.066; no demonstrated comparable Mac path),
Phonon-2 (7.229), Canary 1B v2 (7.911), Whisper large-v3 (7.841), and Voxtral
Mini Realtime 4B (9.013). None established a better broad-accuracy Mac choice
than Qwen 1.7B. Scores use the same HF snapshot, with the Higgs caveat retained.

The transcribe.cpp maintainer reports Q8 Metal warm compute on M4 Max,
commit `77b0c93`, 14 September: 35.3-second audio takes Canary 961.4 ms,
Qwen 1.7B 959 ms, Cohere 470 ms, Granite AR 445 ms, NAR 466 ms, Granite 5
86 ms. Q8 weight files are respectively 2.80, 2.19, 2.41, 2.56, 2.50 GB and
506 MB. These are three iterations after one warmup, excluding load/app
overhead, and file sizes are not RAM. See the maintainer's
[model pages](https://github.com/handy-computer/transcribe.cpp/tree/main/docs/models).
Full LibriSpeech test-clean Q8 WER is respectively 1.63%, 1.62%, 1.27%, 1.32%,
1.29%, 1.33%, but accuracy provenance/backends vary and older rows lack exact
revisions. English FLEURS challenges a universal replacement: Canary 3.58%,
Qwen 3.23%, Cohere 5.08%, Granite AR 4.14%, NAR 5.33%, Granite 5 4.61%.

Cohere and Apache Granite models have existing MLX/Metal implementations.
Cohere documents silence hallucination and code-switching limits; Granite AR's
keyword biasing is not exposed by transcribe.cpp. Granite 5's separate
noncommercial sibling must not replace the Apache model.

Canary's local runtime pin predates upstream's
[audio-scaled output budget](https://github.com/handy-computer/transcribe.cpp/commit/ed3468f3881abb9e7b6c7d404f75049aecccb04f)
and repetition guard. No controlled old/new WER improvement was found. Local
30-second chunks use neither overlap nor previous-chunk context: boundary errors
are plausible, not reproduced. The BF16 runtime keeps additional packed gate/up
weights (about 1.31 GiB by tensor dimensions); this explains overhead without
proving a leak. Inspected Canary-Qwen MLX/Core ML ports lack matched corpus
WER/speed/RAM proof; MLX Audio's Canary is the different Canary 1B v2.

Proposed comparison, following the workspace decisions to measure behavior,
reuse a true fit and avoid invented memory limits:

- [x] Research newer models/runtimes and verify deciding numbers at primary sources.
- [ ] Compare installed Qwen 1.7B BF16/8-bit with Canary BF16/Q8 on identical
  public speech: raw WER, names, stop-to-result latency, cold load, peak/resident RAM.
- [ ] Compare pinned/current Canary runtime on dense and boundary-crossing speech.
- [ ] Evaluate Cohere first, then Granite, if existing options do not resolve the
  complaint; review provenance, licenses and dependency authorization before additions.

No personal recordings were accessed. The recommendation is to compare Qwen
1.7B first, preserving the current default until matched measurements support a change.

## Existing application controls — September snapshot

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
| Qwen3-ASR 0.6B **-hf** | 1.70 | 723.1457 |

The Qwen entries are the Transformers reference checkpoints, **not** the MLX
artifacts. Parakeet **Unified** is absent from this snapshot;
it remains unreported rather than borrowing another variant's results. All Live
reference metrics are unreported because this dataset measures after-stop runs.

Additional primary sources were reviewed, but deliberately not mixed into that
sort: [NVIDIA's Unified model card](https://huggingface.co/nvidia/parakeet-unified-en-0.6b),
[Qwen's evaluation](https://huggingface.co/Qwen/Qwen3-ASR-1.7B#evaluation),
[FluidAudio's Apple Silicon benchmarks](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Benchmarks.md),
and [transcribe.cpp's Canary measurements](https://github.com/handy-computer/transcribe.cpp/blob/main/docs/models/canary-qwen-2.5b.md).
The latter two contain useful Mac measurements, but not a matched set covering
our four families, precisions, runtime versions, hardware, and workloads. We do
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
