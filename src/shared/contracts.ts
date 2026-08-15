import { z } from "zod";
import {
  holdShortcutSchema,
  shortcutsUseSamePhysicalKeys,
  toggleShortcutSchema,
  type ShortcutUpdateRequest,
  type ShortcutValidationRequest,
  type ShortcutValidationResult,
} from "./shortcuts";
import {
  AUDIO_MAX_DURATION_MS,
  AUDIO_MAX_FILE_BYTES,
  isAudioProtocolWav,
} from "./audioProtocol";
import {
  MODEL_PERFORMANCE_TIERS,
  modelPerformanceModeSchema,
  modelPerformanceTierSchema,
} from "./modelPerformance";

export {
  MODEL_PERFORMANCE_MODES,
  MODEL_PERFORMANCE_TIERS,
  modelPerformanceModeSchema,
  modelPerformanceTierSchema,
  type ModelPerformanceMode,
  type ModelPerformanceTier,
} from "./modelPerformance";

export const SESSION_STATES = [
  "idle",
  "listening",
  "finalizing",
  "transcribing",
  "inserting",
  "success",
  "error",
] as const;

export const sessionStateSchema = z.enum(SESSION_STATES);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const dictationActivationSchema = z.enum(["hold", "toggle"]);
export type DictationActivation = z.infer<typeof dictationActivationSchema>;

export const sessionSnapshotSchema = z.object({
  state: sessionStateSchema,
  sessionId: z.string().uuid().optional(),
  message: z.string().max(240).optional(),
  startedAt: z.number().int().positive().optional(),
  activation: dictationActivationSchema.optional(),
}).strict();
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;

export const transcriptionSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
  text: z.string(),
  language: z.string().nullable(),
  modelId: z.string(),
  status: z.enum(["complete", "failed"]),
  sourceAppId: z.string().nullable().optional(),
});
export type Transcription = z.infer<typeof transcriptionSchema>;

export const dictionaryEntrySchema = z.object({
  id: z.string().uuid(),
  phrase: z.string().trim().min(1).max(200),
  replacement: z.string().trim().min(1).max(200),
  createdAt: z.number().int().positive(),
});
export type DictionaryEntry = z.infer<typeof dictionaryEntrySchema>;

export const snippetSchema = z.object({
  id: z.string().uuid(),
  trigger: z.string().trim().min(1).max(80),
  expansion: z.string().trim().min(1).max(10_000),
  createdAt: z.number().int().positive(),
});
export type Snippet = z.infer<typeof snippetSchema>;

export const scratchpadNoteSchema = z.object({
  id: z.string().uuid(),
  body: z.string().max(1_000_000),
  title: z.string().min(1).max(1_000_000),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
});
export type ScratchpadNote = z.infer<typeof scratchpadNoteSchema>;

export const appProfileSchema = z.object({
  id: z.string().uuid(),
  appId: z.string().trim().min(1).max(300),
  label: z.string().trim().min(1).max(120),
  removeFillers: z.boolean(),
  spokenCommands: z.boolean(),
  smartPunctuation: z.boolean(),
  createdAt: z.number().int().positive(),
});
export type AppProfile = z.infer<typeof appProfileSchema>;

/**
 * These are the retention choices LocalScribe supports today.  Keeping the
 * values in one exported tuple prevents the persistence schema, UI, and
 * pruning code from silently drifting apart.
 */
export const HISTORY_RETENTION_OPTIONS = [7, 30, 90, 0] as const;
export type HistoryRetentionDays = (typeof HISTORY_RETENTION_OPTIONS)[number];
export const historyRetentionDaysSchema = z.literal(HISTORY_RETENTION_OPTIONS);

/** Maximum number of encrypted transcript rows returned to a renderer. */
export const MAX_HISTORY_ITEMS = 500;

export function historyRetentionLabel(days: HistoryRetentionDays): string {
  return days === 0 ? "Forever" : `${days} days`;
}

/** Curated local ASR families shipped with this application. */
export const MODEL_FAMILY_IDS = [
  "parakeet-unified-en-0-6b",
  "whisper-large-v3",
  "qwen3-asr-0-6b",
  "qwen3-asr-1-7b",
  "whisper-large-v2",
 ] as const;
/**
 * Backward-safe global default. The runtime catalog exposes a platform-aware
 * recommendation; macOS can recommend Parakeet without making a fresh Windows
 * database select an unsupported family.
 */
export const DEFAULT_MODEL_FAMILY_ID = "whisper-large-v3" as const;
export const modelFamilyIdSchema = z.enum(MODEL_FAMILY_IDS);
export type ModelFamilyId = z.infer<typeof modelFamilyIdSchema>;

/** How an ASR family consumes a dictation session. */
export const ASR_MODES = ["after-stop", "live"] as const;
export const asrModeSchema = z.enum(ASR_MODES);
export type AsrMode = z.infer<typeof asrModeSchema>;

/**
 * Renderer-safe, allowlisted ASR capabilities. A missing `true` is never
 * support: callers must reject a requested capability unless it is declared.
 */
export const modelCapabilitiesSchema = z.object({
  modes: z.array(asrModeSchema).min(1).max(ASR_MODES.length).refine(
    (modes) => new Set(modes).size === modes.length,
    "Each ASR mode can appear only once.",
  ),
  partialResults: z.boolean(),
  timestamps: z.boolean(),
  languageDetection: z.boolean(),
  promptContext: z.boolean(),
  keywordBoost: z.boolean(),
  supportedLanguages: z.array(z.string().trim().min(1).max(80)).min(1).max(100).refine(
    (languages) => new Set(languages).size === languages.length,
    "Each supported language can appear only once.",
  ),
}).strict().superRefine((capabilities, context) => {
  if (capabilities.partialResults && !capabilities.modes.includes("live")) {
    context.addIssue({
      code: "custom",
      path: ["partialResults"],
      message: "Partial results require the live ASR mode.",
    });
  }
});
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

const modelLibraryFamilyIdsSchema = z.array(modelFamilyIdSchema)
  .min(1)
  .refine((familyIds) => new Set(familyIds).size === familyIds.length, {
    message: "Each model family can appear in the library only once.",
  });

const appSettingsFieldsSchema = z.object({
  launchAtLogin: z.boolean(),
  showPillWhenIdle: z.boolean(),
  autoPaste: z.boolean(),
  keepHistory: z.boolean(),
  language: z.string().min(1).max(80),
  microphoneId: z.string().max(500).nullable(),
  asrMode: asrModeSchema,
  modelPerformanceMode: modelPerformanceModeSchema,
  activeModelFamilyId: modelFamilyIdSchema,
  modelLibraryFamilyIds: modelLibraryFamilyIdsSchema,
  historyRetentionDays: historyRetentionDaysSchema,
  removeFillers: z.boolean(),
  spokenCommands: z.boolean(),
  smartPunctuation: z.boolean(),
  holdShortcut: holdShortcutSchema,
  toggleShortcut: toggleShortcutSchema,
});

export const appSettingsSchema = appSettingsFieldsSchema.superRefine((settings, context) => {
  if (shortcutsUseSamePhysicalKeys(settings.holdShortcut, settings.toggleShortcut)) {
    context.addIssue({
      code: "custom",
      path: ["toggleShortcut"],
      message: "Push-to-talk and toggle dictation must use different shortcuts.",
    });
  }
  if (!settings.modelLibraryFamilyIds.includes(settings.activeModelFamilyId)) {
    context.addIssue({
      code: "custom",
      path: ["activeModelFamilyId"],
      message: "The active model family must be in the local model library.",
    });
  }
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

/**
 * A field-level update merged against current persisted settings in main.
 *
 * Model routing is intentionally absent. Family and performance mode must be
 * committed together through modelSelectionApplyRequestSchema, after main has
 * unloaded the old runtime and proved the target can be loaded.
 */
export const appSettingsPatchSchema = appSettingsFieldsSchema.omit({
  modelPerformanceMode: true,
  activeModelFamilyId: true,
  modelLibraryFamilyIds: true,
}).partial().strict().refine(
  (patch) => Object.keys(patch).length > 0,
  "Choose at least one setting to update.",
);
export type AppSettingsPatch = z.infer<typeof appSettingsPatchSchema>;

export const runtimePlatformSchema = z.enum(["darwin", "win32", "linux", "unsupported"]);
export type RuntimePlatform = z.infer<typeof runtimePlatformSchema>;

export const permissionSnapshotSchema = z.object({
  platform: runtimePlatformSchema,
  microphone: z.enum(["not-determined", "granted", "denied", "restricted", "unknown"]),
  microphoneSettingsAvailable: z.boolean(),
  accessibility: z.object({
    supported: z.boolean(),
    granted: z.boolean(),
  }),
  automaticPaste: z.object({
    supported: z.boolean(),
    ready: z.boolean(),
  }),
  globalHold: z.object({
    supported: z.boolean(),
    ready: z.boolean(),
  }),
  /*
   * Whether the toggle accelerator is actually registered.
   *
   * Startup does not fail when it cannot be claimed, because push-to-talk must
   * keep working. That left every surface — the tray menu, the app menu item,
   * the Settings help text — confidently advertising a key that did nothing,
   * and `globalHold.ready` is true in precisely that situation, so nothing
   * existing could stand in for it.
   *
   * Carries no message: the underlying reason can embed an error string, and
   * this crosses IPC. The renderer composes what the user reads.
   */
  globalToggle: z.object({
    supported: z.boolean(),
    ready: z.boolean(),
  }),
});
export type PermissionSnapshot = z.infer<typeof permissionSnapshotSchema>;

export const appInfoSchema = z.object({
  version: z.string().trim().min(1).max(128),
  platform: runtimePlatformSchema,
});
export type AppInfo = z.infer<typeof appInfoSchema>;

export const launchAtLoginStatusSchema = z.object({
  supported: z.boolean(),
  registered: z.boolean(),
  effective: z.boolean(),
  requiresApproval: z.boolean(),
  status: z.enum([
    "enabled",
    "disabled",
    "requires-approval",
    "not-registered",
    "unavailable",
  ]),
}).strict();
export type LaunchAtLoginStatus = z.infer<typeof launchAtLoginStatusSchema>;

const modelVerificationStatusSchema = z.enum(["missing", "invalid", "verified"]);
const acceleratorMemoryBasisSchema = z.enum(["measured", "estimated", "unavailable"]);
const modelMemoryBasisSchema = z.enum(["measured", "estimated"]);

const modelDiagnosticsSchema = z.object({
  familyId: modelFamilyIdSchema,
  artifactId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  profileId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  displayName: z.string(),
  modelId: z.string(),
  storageDirectory: z.string(),
  // Backward-compatible UI field. It is true only after every manifest file
  // has passed its cryptographic digest check; it is not a size-only signal.
  installed: z.boolean(),
  // Runtime readiness is distinct from an installed, verified artifact. This
  // is true only while the worker reports the exact resolved selection warm.
  loaded: z.boolean(),
  present: z.boolean(),
  verified: z.boolean(),
  verificationStatus: modelVerificationStatusSchema,
  sizeBytes: z.number().int().nonnegative(),
  expectedBytes: z.number().int().nonnegative(),
  verifiedFiles: z.number().int().nonnegative(),
  expectedFiles: z.number().int().positive(),
  revision: z.string(),
  license: z.string(),
});

export const diagnosticsSchema = z.object({
  platform: z.string(),
  architecture: z.string(),
  backend: z.string(),
  databaseIntegrity: z.string(),
  /*
   * Stored records this run could not decrypt. Non-zero means history,
   * snippets, scratchpad, and export are all partial, which the user must be
   * able to see rather than infer from a list that quietly got shorter.
   */
  unreadableRecords: z.number().int().nonnegative(),
  model: modelDiagnosticsSchema,
  accelerator: z.object({
    kind: z.enum(["apple-unified", "nvidia-cuda", "unsupported"]),
    displayName: z.string(),
    totalMemoryBytes: z.number().int().nonnegative().nullable(),
    freeMemoryBytes: z.number().int().nonnegative().nullable(),
    memoryBasis: acceleratorMemoryBasisSchema,
  }),
  performance: z.object({
    preference: modelPerformanceModeSchema,
    resolvedTier: modelPerformanceTierSchema.nullable(),
    fitsMemoryBudget: z.boolean(),
    resolutionReason: z.string().nullable(),
    // `requiredFreeMemoryBytes` is maximum model working memory plus the
    // explicitly reported system safety headroom, never merely download size.
    reservedHeadroomBytes: z.number().int().nonnegative().nullable(),
    requiredFreeMemoryBytes: z.number().int().nonnegative().nullable(),
    options: z.array(z.object({
      tier: modelPerformanceTierSchema,
      modelKey: z.string().min(1).max(200),
      profileId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
      artifactId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
      displayName: z.string(),
      engine: z.string(),
      precision: z.string(),
      expectedMemoryMinBytes: z.number().int().nonnegative(),
      expectedMemoryMaxBytes: z.number().int().nonnegative(),
      memoryBasis: modelMemoryBasisSchema,
      expectedDownloadBytes: z.number().int().nonnegative(),
      qualityNote: z.string(),
      verificationStatus: modelVerificationStatusSchema,
      installed: z.boolean(),
      present: z.boolean(),
      verified: z.boolean(),
    })).min(1).max(MODEL_PERFORMANCE_TIERS.length),
  }),
  dataPath: z.string(),
});
export type Diagnostics = z.infer<typeof diagnosticsSchema>;

const modelCatalogArtifactSchema = z.object({
  artifactId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  displayName: z.string().min(1).max(200),
  backend: z.string().min(1).max(120),
  modelId: z.string().min(1).max(200),
  storageDirectory: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  license: z.string().min(1).max(120),
  expectedDownloadBytes: z.number().int().positive(),
}).strict();

const modelCatalogProfileSchema = z.object({
  profileId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  tier: modelPerformanceTierSchema,
  artifactId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  engine: z.enum(["mlx-whisper", "mlx-audio", "fluid-audio", "faster-whisper", "crispasr"]),
  precision: z.string().min(1).max(40),
  expectedMemoryMinBytes: z.number().int().positive(),
  expectedMemoryMaxBytes: z.number().int().positive(),
  memoryBasis: modelMemoryBasisSchema,
}).strict();

const modelCatalogVerificationSchema = z.object({
  familyId: modelFamilyIdSchema,
  artifactId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  present: z.boolean(),
  verified: z.boolean(),
  verificationStatus: modelVerificationStatusSchema,
  sizeBytes: z.number().int().nonnegative(),
  expectedBytes: z.number().int().nonnegative(),
  verifiedFiles: z.number().int().nonnegative(),
  expectedFiles: z.number().int().positive(),
}).strict().superRefine((verification, context) => {
  if (verification.verified !== (verification.verificationStatus === "verified")) {
    context.addIssue({
      code: "custom",
      path: ["verified"],
      message: "Artifact verified state is inconsistent.",
    });
  }
  if (verification.present !== (verification.verificationStatus !== "missing")) {
    context.addIssue({
      code: "custom",
      path: ["present"],
      message: "Artifact presence state is inconsistent.",
    });
  }
  if (verification.verifiedFiles > verification.expectedFiles) {
    context.addIssue({
      code: "custom",
      path: ["verifiedFiles"],
      message: "Verified file count exceeds the manifest.",
    });
  }
  if (verification.verified && verification.verifiedFiles !== verification.expectedFiles) {
    context.addIssue({
      code: "custom",
      path: ["verifiedFiles"],
      message: "A verified artifact must verify every manifest file.",
    });
  }
});

const unmanagedModelEntrySchema = z.object({
  name: z.string().min(1).max(255).regex(/^[^/\\\0]+$/),
  kind: z.enum(["directory", "file", "symlink", "other"]),
  reason: z.enum(["unmanaged", "interrupted-install"]),
  sizeBytes: z.number().int().nonnegative().nullable(),
}).strict();

const modelCatalogFamilySchema = z.object({
  familyId: modelFamilyIdSchema,
  displayName: z.string().min(1).max(200),
  capabilities: modelCapabilitiesSchema,
  /** Exactly one available family is the platform's fresh-install recommendation. */
  recommendedDefault: z.boolean(),
  active: z.boolean(),
  inLibrary: z.boolean(),
  artifacts: z.array(modelCatalogArtifactSchema).min(1),
  /** A family exposes only profiles backed by a complete curated artifact. */
  profiles: z.array(modelCatalogProfileSchema).min(1).max(MODEL_PERFORMANCE_TIERS.length),
}).strict();

/** A static curated platform catalog; it deliberately contains no hardware probe result. */
export const modelCatalogSchema = z.object({
  platform: z.enum(["darwin-arm64", "win32-x64-cuda"]),
  activeModelFamilyId: modelFamilyIdSchema,
  modelLibraryFamilyIds: modelLibraryFamilyIdsSchema,
  /** Independent of persisted user settings; used for platform-aware first run. */
  recommendedDefaultFamilyId: modelFamilyIdSchema,
  /** Unsupported families are absent instead of being represented by fake profiles. */
  families: z.array(modelCatalogFamilySchema).min(1).max(MODEL_FAMILY_IDS.length),
  /**
   * Current cryptographic disk status for every distinct curated artifact.
   * Profiles join through artifactId, so Windows' shared model data appears
   * once per family even though it powers three compute profiles.
   */
  verifications: z.array(modelCatalogVerificationSchema),
  /** Unexpected app-owned model-root entries are reported, never auto-deleted. */
  unmanagedEntries: z.array(unmanagedModelEntrySchema).max(1_000),
}).strict().superRefine((catalog, context) => {
  if (!catalog.modelLibraryFamilyIds.includes(catalog.activeModelFamilyId)) {
    context.addIssue({
      code: "custom",
      path: ["activeModelFamilyId"],
      message: "The active model family must be in the local model library.",
    });
  }
  const seenFamilies = new Set<string>();
  let recommendedDefaultCount = 0;
  const expectedArtifacts = new Map<string, number>();
  for (const [index, family] of catalog.families.entries()) {
    if (seenFamilies.has(family.familyId)) {
      context.addIssue({ code: "custom", path: ["families", index, "familyId"], message: "Duplicate family." });
    }
    seenFamilies.add(family.familyId);
    if (family.active !== (family.familyId === catalog.activeModelFamilyId)) {
      context.addIssue({ code: "custom", path: ["families", index, "active"], message: "Family active flag is inconsistent." });
    }
    if (family.recommendedDefault) recommendedDefaultCount += 1;
    if (family.recommendedDefault !== (family.familyId === catalog.recommendedDefaultFamilyId)) {
      context.addIssue({
        code: "custom",
        path: ["families", index, "recommendedDefault"],
        message: "Family recommendation flag is inconsistent.",
      });
    }
    if (family.inLibrary !== catalog.modelLibraryFamilyIds.includes(family.familyId)) {
      context.addIssue({ code: "custom", path: ["families", index, "inLibrary"], message: "Family library flag is inconsistent." });
    }
    const familyArtifactIds = new Set<string>();
    for (const [artifactIndex, artifact] of family.artifacts.entries()) {
      if (familyArtifactIds.has(artifact.artifactId)) {
        context.addIssue({
          code: "custom",
          path: ["families", index, "artifacts", artifactIndex, "artifactId"],
          message: "Duplicate curated artifact.",
        });
      }
      familyArtifactIds.add(artifact.artifactId);
      expectedArtifacts.set(
        `${family.familyId}\u0000${artifact.artifactId}`,
        artifact.expectedDownloadBytes,
      );
    }
    const familyProfileIds = new Set<string>();
    const familyTiers = new Set<string>();
    for (const [profileIndex, profile] of family.profiles.entries()) {
      if (familyProfileIds.has(profile.profileId)) {
        context.addIssue({
          code: "custom",
          path: ["families", index, "profiles", profileIndex, "profileId"],
          message: "Duplicate curated profile.",
        });
      }
      familyProfileIds.add(profile.profileId);
      if (familyTiers.has(profile.tier)) {
        context.addIssue({
          code: "custom",
          path: ["families", index, "profiles", profileIndex, "tier"],
          message: "Each performance tier must appear once per family.",
        });
      }
      familyTiers.add(profile.tier);
      if (!familyArtifactIds.has(profile.artifactId)) {
        context.addIssue({
          code: "custom",
          path: ["families", index, "profiles", profileIndex, "artifactId"],
          message: "Profile does not reference a curated family artifact.",
        });
      }
    }
  }
  if (!seenFamilies.has(catalog.activeModelFamilyId)) {
    context.addIssue({
      code: "custom",
      path: ["activeModelFamilyId"],
      message: "The active model family is unavailable on this platform.",
    });
  }
  for (const [index, familyId] of catalog.modelLibraryFamilyIds.entries()) {
    if (!seenFamilies.has(familyId)) {
      context.addIssue({
        code: "custom",
        path: ["modelLibraryFamilyIds", index],
        message: "The model library contains a family unavailable on this platform.",
      });
    }
  }
  if (recommendedDefaultCount !== 1 || !seenFamilies.has(catalog.recommendedDefaultFamilyId)) {
    context.addIssue({
      code: "custom",
      path: ["recommendedDefaultFamilyId"],
      message: "Exactly one available family must be the platform recommendation.",
    });
  }
  const seenVerifications = new Set<string>();
  for (const [index, verification] of catalog.verifications.entries()) {
    const key = `${verification.familyId}\u0000${verification.artifactId}`;
    if (seenVerifications.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["verifications", index],
        message: "Duplicate artifact verification.",
      });
    }
    seenVerifications.add(key);
    const expectedBytes = expectedArtifacts.get(key);
    if (expectedBytes === undefined) {
      context.addIssue({
        code: "custom",
        path: ["verifications", index, "artifactId"],
        message: "Verification does not reference a curated artifact.",
      });
    } else if (verification.expectedBytes !== expectedBytes) {
      context.addIssue({
        code: "custom",
        path: ["verifications", index, "expectedBytes"],
        message: "Verification byte total does not match the curated artifact.",
      });
    }
  }
  for (const expected of expectedArtifacts.keys()) {
    if (!seenVerifications.has(expected)) {
      context.addIssue({
        code: "custom",
        path: ["verifications"],
        message: "Every curated artifact must have one verification result.",
      });
      break;
    }
  }
  const seenUnmanagedEntries = new Set<string>();
  for (const [index, entry] of catalog.unmanagedEntries.entries()) {
    if (seenUnmanagedEntries.has(entry.name)) {
      context.addIssue({
        code: "custom",
        path: ["unmanagedEntries", index, "name"],
        message: "Duplicate unmanaged model-root entry.",
      });
    }
    seenUnmanagedEntries.add(entry.name);
  }
});
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;

export const modelFamilyLibraryRequestSchema = z.object({
  familyId: modelFamilyIdSchema,
}).strict();
export type ModelFamilyLibraryRequest = z.infer<typeof modelFamilyLibraryRequestSchema>;

export const modelSelectionApplyRequestSchema = z.object({
  familyId: modelFamilyIdSchema,
  /** Older renderers remain compatible; main still validates catalog support. */
  asrMode: asrModeSchema.default("after-stop"),
  performanceMode: modelPerformanceModeSchema,
}).strict();
export type ModelSelectionApplyRequest = z.infer<typeof modelSelectionApplyRequestSchema>;

export const modelSelectionApplyResultSchema = z.object({
  settings: appSettingsSchema,
  catalog: modelCatalogSchema,
  diagnostics: diagnosticsSchema,
}).strict();
export type ModelSelectionApplyResult = z.infer<typeof modelSelectionApplyResultSchema>;

export const modelInstallRequestSchema = z.object({
  confirmed: z.literal(true),
  replaceExisting: z.boolean(),
  familyId: modelFamilyIdSchema,
  tier: modelPerformanceTierSchema,
}).strict();
export type ModelInstallRequest = z.infer<typeof modelInstallRequestSchema>;

export const modelRemoveRequestSchema = z.object({
  confirmed: z.literal(true),
  familyId: modelFamilyIdSchema,
  tier: modelPerformanceTierSchema,
}).strict();
export type ModelRemoveRequest = z.infer<typeof modelRemoveRequestSchema>;

export const NAVIGATION_TARGETS = [
  "dictation",
  "insights",
  "dictionary",
  "snippets",
  "style",
  "transforms",
  "scratchpad",
  "settings",
] as const;
export const navigationTargetSchema = z.enum(NAVIGATION_TARGETS);
export type NavigationTarget = (typeof NAVIGATION_TARGETS)[number];

export const PILL_MODES = ["collapsed", "hover", "picker"] as const;
export const pillModeSchema = z.enum(PILL_MODES);
export type PillMode = z.infer<typeof pillModeSchema>;

export const DEFAULT_SETTINGS: AppSettings = {
  launchAtLogin: false,
  showPillWhenIdle: true,
  autoPaste: true,
  keepHistory: true,
  language: "auto",
  microphoneId: null,
  asrMode: "after-stop",
  modelPerformanceMode: "auto",
  activeModelFamilyId: DEFAULT_MODEL_FAMILY_ID,
  modelLibraryFamilyIds: [DEFAULT_MODEL_FAMILY_ID],
  historyRetentionDays: 30,
  removeFillers: true,
  spokenCommands: true,
  smartPunctuation: true,
  holdShortcut: "Control",
  toggleShortcut: "Control+Space",
};

/**
 * Upgrade a persisted settings object field by field.
 *
 * Settings live longer than any one application build. A removed enum value
 * or one damaged field must not make every unrelated preference unreadable.
 * Valid saved values win, new fields receive current policy defaults, unknown
 * legacy fields are discarded, and cross-field invariants are repaired
 * deterministically before the complete object is validated.
 */
export function migratePersistedAppSettings(raw: unknown): AppSettings {
  const source = raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const defaults = appSettingsSchema.parse(DEFAULT_SETTINGS);
  const candidate: Record<keyof AppSettings, unknown> = { ...defaults };
  const fieldSchemas = appSettingsFieldsSchema.shape;

  for (const key of Object.keys(fieldSchemas) as Array<keyof typeof fieldSchemas>) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const parsed = fieldSchemas[key].safeParse(source[key]);
    if (parsed.success) candidate[key] = parsed.data;
  }

  const library = candidate.modelLibraryFamilyIds as AppSettings["modelLibraryFamilyIds"];
  const activeFamily = candidate.activeModelFamilyId as AppSettings["activeModelFamilyId"];
  if (!library.includes(activeFamily)) {
    candidate.activeModelFamilyId = library.includes(DEFAULT_MODEL_FAMILY_ID)
      ? DEFAULT_MODEL_FAMILY_ID
      : library[0];
  }

  if (shortcutsUseSamePhysicalKeys(
    candidate.holdShortcut as AppSettings["holdShortcut"],
    candidate.toggleShortcut as AppSettings["toggleShortcut"],
  )) {
    candidate.toggleShortcut = defaults.toggleShortcut;
    // A legacy hold shortcut may itself equal today's default toggle. In that
    // case resetting only the toggle reproduces the conflict, so restore the
    // hold policy default as the second deterministic repair.
    if (shortcutsUseSamePhysicalKeys(
      candidate.holdShortcut as AppSettings["holdShortcut"],
      candidate.toggleShortcut as AppSettings["toggleShortcut"],
    )) {
      candidate.holdShortcut = defaults.holdShortcut;
    }
  }

  return appSettingsSchema.parse(candidate);
}

export const transcribeAudioSchema = z.object({
  sessionId: z.string().uuid(),
  wav: z.instanceof(ArrayBuffer)
    .refine((wav) => wav.byteLength <= AUDIO_MAX_FILE_BYTES, "Recording is too large")
    .refine(isAudioProtocolWav, "Recording must be mono 16 kHz PCM16 WAV"),
  durationMs: z.number().int().positive().max(AUDIO_MAX_DURATION_MS),
}).strict();
export type TranscribeAudioRequest = z.infer<typeof transcribeAudioSchema>;

export const IPC = {
  sessionGet: "session:get",
  sessionChanged: "session:changed",
  sessionToggle: "session:toggle",
  sessionCancel: "session:cancel",
  sessionFail: "session:fail",
  sessionTranscribe: "session:transcribe",
  historyList: "history:list",
  historyChanged: "history:changed",
  historyDelete: "history:delete",
  historyClear: "history:clear",
  historyExport: "history:export",
  settingsChanged: "settings:changed",
  dictionaryList: "dictionary:list",
  dictionarySave: "dictionary:save",
  dictionaryDelete: "dictionary:delete",
  snippetsList: "snippets:list",
  snippetsSave: "snippets:save",
  snippetsDelete: "snippets:delete",
  profilesList: "profiles:list",
  profilesSave: "profiles:save",
  profilesDelete: "profiles:delete",
  scratchpadList: "scratchpad:list",
  scratchpadCreate: "scratchpad:create",
  scratchpadUpdate: "scratchpad:update",
  scratchpadDelete: "scratchpad:delete",
  settingsGet: "settings:get",
  settingsPatch: "settings:patch",
  shortcutsBeginCapture: "shortcuts:begin-capture",
  shortcutsEndCapture: "shortcuts:end-capture",
  shortcutsValidate: "shortcuts:validate",
  shortcutsUpdate: "shortcuts:update",
  windowShowSettings: "window:show-settings",
  windowSetPillMode: "window:set-pill-mode",
  windowCloseScratchpad: "window:close-scratchpad",
  windowToggleScratchpadSize: "window:toggle-scratchpad-size",
  windowNavigate: "window:navigate",
  windowVisibility: "window:visibility",
  windowPillMode: "window:pill-mode",
  systemGetPermissions: "system:get-permissions",
  systemGetLaunchAtLoginStatus: "system:get-launch-at-login-status",
  systemOpenPermission: "system:open-permission",
  systemAppInfo: "system:app-info",
  systemDiagnostics: "system:diagnostics",
  systemDiagnosticsLog: "system:diagnostics-log",
  systemModelCatalog: "system:model-catalog",
  systemAddModelFamily: "system:add-model-family",
  systemApplyModelSelection: "system:apply-model-selection",
  systemInstallModel: "system:install-model",
  systemRemoveModel: "system:remove-model",
} as const;

export interface LocalScribeApi {
  session: {
    get(): Promise<SessionSnapshot>;
    toggle(): Promise<SessionSnapshot>;
    cancel(): Promise<SessionSnapshot>;
    fail(message: string): Promise<SessionSnapshot>;
    transcribe(request: TranscribeAudioRequest): Promise<Transcription>;
    onChanged(listener: (snapshot: SessionSnapshot) => void): () => void;
  };
  history: {
    list(limit?: number): Promise<Transcription[]>;
    delete(id: string): Promise<void>;
    clear(): Promise<void>;
    export(): Promise<string | null>;
    onChanged(listener: () => void): () => void;
  };
  dictionary: {
    list(): Promise<DictionaryEntry[]>;
    save(input: Pick<DictionaryEntry, "phrase" | "replacement">): Promise<DictionaryEntry>;
    delete(id: string): Promise<void>;
  };
  snippets: {
    list(): Promise<Snippet[]>;
    save(input: Pick<Snippet, "trigger" | "expansion">): Promise<Snippet>;
    delete(id: string): Promise<void>;
  };
  profiles: {
    list(): Promise<AppProfile[]>;
    save(input: Omit<AppProfile, "id" | "createdAt">): Promise<AppProfile>;
    delete(id: string): Promise<void>;
  };
  scratchpad: {
    list(): Promise<ScratchpadNote[]>;
    create(): Promise<ScratchpadNote>;
    update(id: string, body: string): Promise<ScratchpadNote>;
    delete(id: string): Promise<void>;
  };
  settings: {
    get(): Promise<AppSettings>;
    patch(input: AppSettingsPatch): Promise<AppSettings>;
    onChanged(listener: (settings: AppSettings) => void): () => void;
  };
  shortcuts: {
    beginCapture(): Promise<void>;
    endCapture(): Promise<void>;
    validate(input: ShortcutValidationRequest): Promise<ShortcutValidationResult>;
    update(input: ShortcutUpdateRequest): Promise<AppSettings>;
  };
  windows: {
    showSettings(target?: NavigationTarget): Promise<void>;
    setPillMode(mode: PillMode): Promise<void>;
    closeScratchpad(): Promise<void>;
    toggleScratchpadSize(): Promise<void>;
    onNavigate(listener: (target: NavigationTarget) => void): () => void;
    /**
     * Native window visibility, pushed from main.
     *
     * The renderer cannot derive this itself: every window sets
     * `backgroundThrottling: false`, which pins `document.visibilityState` to
     * "visible" and leaves timers running at full rate even while the window is
     * hidden. Verified in Electron 43 — a hidden window still reported
     * "visible" and a 100 ms interval still fired 10 times per second.
     */
    onVisibilityChanged(listener: (visible: boolean) => void): () => void;
    /**
     * The pill's committed native size, pushed from main.
     *
     * Main owns the transparent window and resizes it from the real cursor
     * position, which the renderer cannot see. Resizing a window under a
     * stationary pointer does not synthesize pointer boundary events, so
     * without this the renderer keeps drawing the expanded controls inside a
     * 40x8 window after main has already contracted it.
     */
    onPillModeChanged(listener: (mode: PillMode) => void): () => void;
  };
  system: {
    getPermissions(): Promise<PermissionSnapshot>;
    getLaunchAtLoginStatus(): Promise<LaunchAtLoginStatus>;
    openPermission(kind: "microphone" | "accessibility"): Promise<void>;
    appInfo(): Promise<AppInfo>;
    diagnostics(): Promise<Diagnostics>;
    /** Redacted rotating failure trail, for "Copy diagnostics". */
    diagnosticsLog(): Promise<string>;
    modelCatalog(): Promise<ModelCatalog>;
    addModelFamily(request: ModelFamilyLibraryRequest): Promise<ModelCatalog>;
    applyModelSelection(request: ModelSelectionApplyRequest): Promise<ModelSelectionApplyResult>;
    installModel(request: ModelInstallRequest): Promise<Diagnostics>;
    removeModel(request: ModelRemoveRequest): Promise<Diagnostics>;
  };
}
