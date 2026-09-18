import type { AppSettings, Diagnostics } from "../shared/contracts";
import { UNAVAILABLE_MODEL_SELECTION_MESSAGE } from "../shared/modelAvailability";

/** An unresolved selection is not a missing download or a substituted model. */
export function unavailableModelDiagnostics(
  settings: Pick<AppSettings, "activeModelFamilyId" | "modelPerformanceMode">,
  base: Omit<Diagnostics, "model" | "performance" | "backend">,
): Diagnostics {
  return {
    ...base,
    backend: "Unavailable selection",
    model: {
      familyId: settings.activeModelFamilyId,
      artifactId: "unavailable",
      profileId: "unavailable",
      displayName: "Saved selection unavailable",
      modelId: "",
      storageDirectory: "",
      installed: false,
      loaded: false,
      present: false,
      verified: false,
      verificationStatus: "unavailable",
      sizeBytes: 0,
      expectedBytes: 0,
      verifiedFiles: 0,
      expectedFiles: 0,
      revision: "",
      license: "",
    },
    performance: {
      preference: settings.modelPerformanceMode,
      resolvedTier: null,
      fitsMemoryBudget: false,
      resolutionReason: UNAVAILABLE_MODEL_SELECTION_MESSAGE,
      reservedHeadroomBytes: null,
      requiredFreeMemoryBytes: null,
      options: [],
    },
  };
}
