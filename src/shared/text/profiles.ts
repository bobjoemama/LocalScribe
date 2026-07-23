import type {
  AppCleanupProfile,
  CleanupPresetName,
  TextCleanupOptions,
} from "./types";

export const CLEANUP_PRESETS: Readonly<Record<CleanupPresetName, Readonly<TextCleanupOptions>>> = {
  balanced: {
    fillerMode: "conservative",
    customFillers: [],
    punctuationCommands: true,
    paragraphCommands: true,
    scratchCommands: true,
    capitalizeSentences: true,
    terminalPunctuation: "preserve",
    normalizeWhitespace: true,
  },
  message: {
    fillerMode: "conservative",
    customFillers: [],
    punctuationCommands: true,
    paragraphCommands: true,
    scratchCommands: true,
    capitalizeSentences: true,
    terminalPunctuation: "preserve",
    normalizeWhitespace: true,
  },
  document: {
    fillerMode: "conservative",
    customFillers: [],
    punctuationCommands: true,
    paragraphCommands: true,
    scratchCommands: true,
    capitalizeSentences: true,
    terminalPunctuation: "ensure",
    normalizeWhitespace: true,
  },
  verbatim: {
    fillerMode: "off",
    customFillers: [],
    punctuationCommands: false,
    paragraphCommands: false,
    scratchCommands: false,
    capitalizeSentences: false,
    terminalPunctuation: "preserve",
    normalizeWhitespace: false,
  },
};

export const DEFAULT_CLEANUP_OPTIONS: Readonly<TextCleanupOptions> = CLEANUP_PRESETS.balanced;

function mergeOptions(
  base: Readonly<TextCleanupOptions>,
  overrides?: Partial<TextCleanupOptions>,
): TextCleanupOptions {
  return {
    ...base,
    ...overrides,
    customFillers: [...(overrides?.customFillers ?? base.customFillers)],
  };
}

export function cleanupOptionsForPreset(
  preset: CleanupPresetName = "balanced",
  overrides?: Partial<TextCleanupOptions>,
): TextCleanupOptions {
  return mergeOptions(CLEANUP_PRESETS[preset], overrides);
}

export function resolveAppCleanupOptions(
  appId: string | null | undefined,
  profiles: readonly AppCleanupProfile[],
  fallbackPreset: CleanupPresetName = "balanced",
): TextCleanupOptions {
  const normalizedAppId = appId?.trim().toLocaleLowerCase("en-US");
  if (!normalizedAppId) return cleanupOptionsForPreset(fallbackPreset);

  const profile = profiles.find(
    (candidate) => candidate.appId.trim().toLocaleLowerCase("en-US") === normalizedAppId,
  );
  if (!profile) return cleanupOptionsForPreset(fallbackPreset);
  return cleanupOptionsForPreset(profile.preset ?? fallbackPreset, profile.overrides);
}
