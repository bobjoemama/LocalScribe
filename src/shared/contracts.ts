import { z } from "zod";
import {
  holdShortcutSchema,
  toggleShortcutSchema,
  type ShortcutValidationRequest,
  type ShortcutValidationResult,
} from "./shortcuts";
import {
  AUDIO_MAX_DURATION_MS,
  AUDIO_MAX_FILE_BYTES,
  isAudioProtocolWav,
} from "./audioProtocol";
import {
  MODEL_PERFORMANCE_MODES,
  MODEL_PERFORMANCE_TIERS,
  modelPerformanceModeSchema,
  modelPerformanceTierSchema,
  type ModelPerformanceMode,
  type ModelPerformanceTier,
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

export const appSettingsSchema = z.object({
  launchAtLogin: z.boolean(),
  showPillWhenIdle: z.boolean(),
  autoPaste: z.boolean(),
  keepHistory: z.boolean(),
  language: z.string().min(1).max(80),
  microphoneId: z.string().max(500).nullable(),
  modelPerformanceMode: modelPerformanceModeSchema,
  historyRetentionDays: historyRetentionDaysSchema,
  removeFillers: z.boolean(),
  spokenCommands: z.boolean(),
  smartPunctuation: z.boolean(),
  holdShortcut: holdShortcutSchema,
  toggleShortcut: toggleShortcutSchema,
}).superRefine((settings, context) => {
  if (settings.holdShortcut !== settings.toggleShortcut) return;
  context.addIssue({
    code: "custom",
    path: ["toggleShortcut"],
    message: "Push-to-talk and toggle dictation must use different shortcuts.",
  });
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

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
});
export type PermissionSnapshot = z.infer<typeof permissionSnapshotSchema>;

export const appInfoSchema = z.object({
  version: z.string().trim().min(1).max(128),
  platform: runtimePlatformSchema,
});
export type AppInfo = z.infer<typeof appInfoSchema>;

const modelVerificationStatusSchema = z.enum(["missing", "invalid", "verified"]);
const acceleratorMemoryBasisSchema = z.enum(["measured", "estimated", "unavailable"]);
const modelMemoryBasisSchema = z.enum(["measured", "estimated"]);

const modelDiagnosticsSchema = z.object({
  displayName: z.string(),
  modelId: z.string(),
  storageDirectory: z.string(),
  // Backward-compatible UI field. It is true only after every manifest file
  // has passed its cryptographic digest check; it is not a size-only signal.
  installed: z.boolean(),
  present: z.boolean(),
  verified: z.boolean(),
  verificationStatus: modelVerificationStatusSchema,
  sizeBytes: z.number().int().nonnegative(),
  expectedBytes: z.number().int().nonnegative(),
  verifiedFiles: z.number().int().nonnegative(),
  expectedFiles: z.number().int().positive(),
  revision: z.string(),
});

export const diagnosticsSchema = z.object({
  platform: z.string(),
  architecture: z.string(),
  backend: z.string(),
  databaseIntegrity: z.string(),
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
    options: z.array(z.object({
      tier: modelPerformanceTierSchema,
      modelKey: z.string().min(1).max(200),
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
    })).length(MODEL_PERFORMANCE_TIERS.length),
  }),
  dataPath: z.string(),
});
export type Diagnostics = z.infer<typeof diagnosticsSchema>;

export const modelInstallRequestSchema = z.object({
  confirmed: z.literal(true),
  replaceExisting: z.boolean(),
  tier: modelPerformanceTierSchema,
}).strict();
export type ModelInstallRequest = z.infer<typeof modelInstallRequestSchema>;

export const modelRemoveRequestSchema = z.object({
  confirmed: z.literal(true),
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
  modelPerformanceMode: "auto",
  historyRetentionDays: 30,
  removeFillers: true,
  spokenCommands: true,
  smartPunctuation: true,
  holdShortcut: "Control",
  toggleShortcut: "Control+Space",
};

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
  settingsSave: "settings:save",
  shortcutsBeginCapture: "shortcuts:begin-capture",
  shortcutsEndCapture: "shortcuts:end-capture",
  shortcutsValidate: "shortcuts:validate",
  windowShowSettings: "window:show-settings",
  windowSetPillMode: "window:set-pill-mode",
  windowCloseScratchpad: "window:close-scratchpad",
  windowToggleScratchpadSize: "window:toggle-scratchpad-size",
  windowNavigate: "window:navigate",
  systemGetPermissions: "system:get-permissions",
  systemOpenPermission: "system:open-permission",
  systemAppInfo: "system:app-info",
  systemDiagnostics: "system:diagnostics",
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
    save(input: AppSettings): Promise<AppSettings>;
    onChanged(listener: (settings: AppSettings) => void): () => void;
  };
  shortcuts: {
    beginCapture(): Promise<void>;
    endCapture(): Promise<void>;
    validate(input: ShortcutValidationRequest): Promise<ShortcutValidationResult>;
  };
  windows: {
    showSettings(target?: NavigationTarget): Promise<void>;
    setPillMode(mode: PillMode): Promise<void>;
    closeScratchpad(): Promise<void>;
    toggleScratchpadSize(): Promise<void>;
    onNavigate(listener: (target: NavigationTarget) => void): () => void;
  };
  system: {
    getPermissions(): Promise<PermissionSnapshot>;
    openPermission(kind: "microphone" | "accessibility"): Promise<void>;
    appInfo(): Promise<AppInfo>;
    diagnostics(): Promise<Diagnostics>;
    installModel(request: ModelInstallRequest): Promise<Diagnostics>;
    removeModel(request: ModelRemoveRequest): Promise<Diagnostics>;
  };
}
