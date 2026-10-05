import type { AsrMode, ModelFamilyId, ModelPerformanceMode } from "./contracts";

export const UNAVAILABLE_MODEL_SELECTION_MESSAGE =
  "This saved model or quality profile is unavailable in this build. Choose a supported model and quality in Settings > Model & Performance, then press Apply model. Your saved selection and model files have not been changed.";

/** Curated names shared by the catalog and the lightweight workspace label. */
export function modelFamilyDisplayName(familyId: ModelFamilyId): string {
  switch (familyId) {
    case "parakeet-unified-en-0-6b": return "Parakeet Unified EN 0.6B";
    case "qwen3-asr-0-6b": return "Qwen3-ASR 0.6B";
    case "qwen3-asr-1-7b": return "Qwen3-ASR 1.7B";
    case "canary-qwen-2-5b": return "Canary-Qwen 2.5B";
    default: return "Unavailable model";
  }
}

/** Shared by main and renderer; no replacement model is selected here. */
export function modelSelectionIsAvailable(
  selection: { familyId: ModelFamilyId; asrMode: AsrMode; performanceMode: ModelPerformanceMode },
  family: { modes: readonly AsrMode[]; tiers: readonly string[] } | undefined,
): boolean {
  return Boolean(family && family.modes.includes(selection.asrMode)
    && family.tiers.length > 0
    && (selection.performanceMode === "auto" || family.tiers.includes(selection.performanceMode)));
}
