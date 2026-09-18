import type { ModelFamilyId } from "./contracts";

/** Reviewed metadata, not a network request or a prediction for the user's Mac. */
export const MODEL_EVIDENCE_REVIEWED = "2026-09-09";
export const REFERENCE_BENCHMARK_URL = "https://huggingface.co/datasets/hf-audio/open-asr-leaderboard-results/blob/ba5712d5ace8f785fa0daae1aecea8561ecd87c9/english_short_latest.csv";
export const REFERENCE_BENCHMARK_CONTEXT = "Hugging Face Open ASR, 4 September 2026 snapshot; LibriSpeech test-clean WER and RTFx from the same dataset column. The leaderboard documents NVIDIA H200 jobs with per-family runtimes, not LocalScribe or Apple Silicon benchmarks. Original/reference checkpoints, not the selected Mac quantization. Higher RTFx is faster; lower WER is better.";

interface ModelEvidence {
  originalModelId: string;
  artifactPublisher: "FluidInference" | "mlx-community" | "handy-computer";
  publisherDescription: string;
  reference: { modelId: string; wer: number; rtfx: number } | null;
}

// Do not substitute another model variant for a missing row.
// The Qwen leaderboard rows are explicitly the Transformers (-hf) checkpoints.
export const MODEL_EVIDENCE: Partial<Record<ModelFamilyId, ModelEvidence>> = {
  "parakeet-unified-en-0-6b": {
    originalModelId: "nvidia/parakeet-unified-en-0.6b",
    artifactPublisher: "FluidInference",
    publisherDescription: "FluidInference runtime-maintainer Core ML conversion (not NVIDIA weights published directly).",
    reference: null,
  },
  "qwen3-asr-0-6b": {
    originalModelId: "Qwen/Qwen3-ASR-0.6B",
    artifactPublisher: "mlx-community",
    publisherDescription: "MLX Community conversion (not a Qwen-published Mac artifact).",
    reference: { modelId: "Qwen/Qwen3-ASR-0.6B-hf", wer: 1.7, rtfx: 723.1457 },
  },
  "qwen3-asr-1-7b": {
    originalModelId: "Qwen/Qwen3-ASR-1.7B",
    artifactPublisher: "mlx-community",
    publisherDescription: "MLX Community conversion (not a Qwen-published Mac artifact).",
    reference: { modelId: "Qwen/Qwen3-ASR-1.7B-hf", wer: 1.26, rtfx: 664.199 },
  },
  "canary-qwen-2-5b": {
    originalModelId: "nvidia/canary-qwen-2.5b",
    artifactPublisher: "handy-computer",
    publisherDescription: "handy-computer runtime-maintainer GGUF conversion (not NVIDIA weights published directly).",
    reference: { modelId: "nvidia/canary-qwen-2.5b", wer: 1.23, rtfx: 678.3482 },
  },
};

/** Only canonical Hub IDs and immutable revisions become artifact source URLs. */
export function modelArtifactSourceUrl(modelId: string, revision: string): string | null {
  if (!/^(FluidInference|mlx-community|handy-computer)\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(modelId)
    || !/^[a-f0-9]{40}$/.test(revision)) return null;
  return `https://huggingface.co/${modelId}/tree/${revision}`;
}
