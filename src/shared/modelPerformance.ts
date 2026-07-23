import { z } from "zod";

export const MODEL_PERFORMANCE_PREFERENCES = ["auto", "high", "medium", "low"] as const;
export const modelPerformancePreferenceSchema = z.enum(MODEL_PERFORMANCE_PREFERENCES);
export type ModelPerformancePreference = z.infer<typeof modelPerformancePreferenceSchema>;

// Mode is retained as a public alias because settings use that user-facing term.
export const MODEL_PERFORMANCE_MODES = MODEL_PERFORMANCE_PREFERENCES;
export const modelPerformanceModeSchema = modelPerformancePreferenceSchema;
export type ModelPerformanceMode = ModelPerformancePreference;

export const MODEL_PERFORMANCE_TIERS = ["high", "medium", "low"] as const;
export const modelPerformanceTierSchema = z.enum(MODEL_PERFORMANCE_TIERS);
export type ModelPerformanceTier = z.infer<typeof modelPerformanceTierSchema>;

export const MODEL_RESOURCE_EVIDENCE_KINDS = ["measured", "estimated"] as const;
export const modelResourceEvidenceKindSchema = z.enum(MODEL_RESOURCE_EVIDENCE_KINDS);
export type ModelResourceEvidenceKind = z.infer<typeof modelResourceEvidenceKindSchema>;

export const acceleratorMemorySnapshotSchema = z.object({
  totalBytes: z.number().int().positive().nullable(),
  freeBytes: z.number().int().nonnegative().nullable(),
}).strict().superRefine((snapshot, context) => {
  if ((snapshot.totalBytes === null) !== (snapshot.freeBytes === null)) {
    context.addIssue({
      code: "custom",
      message: "total and free accelerator memory must either both be available or both be unavailable",
    });
  }
  if (
    snapshot.totalBytes !== null
    && snapshot.freeBytes !== null
    && snapshot.freeBytes > snapshot.totalBytes
  ) {
    context.addIssue({
      code: "custom",
      message: "free accelerator memory cannot exceed total accelerator memory",
      path: ["freeBytes"],
    });
  }
});
export type AcceleratorMemorySnapshot = z.infer<typeof acceleratorMemorySnapshotSchema>;
