import { z } from "zod";

export const appUpdateStateSchema = z.object({
  phase: z.enum([
    "idle", "checking", "current", "available", "downloading", "ready",
    "installing", "error", "unsupported",
  ]),
  currentVersion: z.string().max(256),
  availableVersion: z.string().max(256).optional(),
  message: z.string().max(500).optional(),
}).strict();

export type AppUpdateState = z.infer<typeof appUpdateStateSchema>;

export const updatePreparationSchema = z.object({ requestId: z.uuid() }).strict();
export const updatePreparedSchema = updatePreparationSchema.extend({ prepared: z.boolean() }).strict();
