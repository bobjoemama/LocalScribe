import type { AsrMode, ModelPerformanceTier as ConcreteModelTier, ModelCatalog } from "../../../shared/contracts";
import { MODEL_EVIDENCE } from "../../../shared/modelEvidence";

export const MODEL_SORT_OPTIONS = [
  { id: "recommended", label: "Recommended order" },
  { id: "memory-asc", label: "Estimated memory: low → high" },
  { id: "memory-desc", label: "Estimated memory: high → low" },
  { id: "download-asc", label: "Download size: small → large" },
  { id: "download-desc", label: "Download size: large → small" },
  { id: "wer-asc", label: "Reference WER: low → high" },
  { id: "wer-desc", label: "Reference WER: high → low" },
  { id: "speed-desc", label: "Reference speed: fast → slow" },
  { id: "speed-asc", label: "Reference speed: slow → fast" },
] as const;
export type ModelSortOrder = typeof MODEL_SORT_OPTIONS[number]["id"];
type Family = ModelCatalog["families"][number];

export function isModelSortOrder(value: string): value is ModelSortOrder {
  return MODEL_SORT_OPTIONS.some((option) => option.id === value);
}

export function modelComparisonValues(family: Family, tier: ConcreteModelTier, experience: AsrMode) {
  const profile = family.profiles.find((candidate) => candidate.tier === tier);
  const artifact = family.artifacts.find((candidate) => candidate.artifactId === profile?.artifactId);
  const reference = experience === "after-stop" ? MODEL_EVIDENCE[family.familyId]?.reference : null;
  return {
    memory: profile?.expectedMemoryMaxBytes ?? null,
    download: artifact?.expectedDownloadBytes ?? null,
    wer: reference?.wer ?? null,
    speed: reference?.rtfx ?? null,
  };
}

/** Stable, non-mutating ordering; unavailable values stay last in both directions. */
export function orderModelFamilies(families: readonly Family[], order: ModelSortOrder, tier: ConcreteModelTier, experience: AsrMode): Family[] {
  const visible = families.filter((family) => family.capabilities.modes.includes(experience));
  if (order === "recommended") return visible;
  const [metric, direction] = order.split("-") as ["memory" | "download" | "wer" | "speed", "asc" | "desc"];
  return visible.sort((left, right) => {
    const a = modelComparisonValues(left, tier, experience)[metric];
    const b = modelComparisonValues(right, tier, experience)[metric];
    if (a === null) return b === null ? 0 : 1;
    if (b === null) return -1;
    return (a - b) * (direction === "asc" ? 1 : -1);
  });
}
