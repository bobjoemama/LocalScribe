export type FillerRemovalMode = "off" | "conservative" | "aggressive";

export type TerminalPunctuationMode = "preserve" | "ensure" | "strip";

export interface TextCleanupOptions {
  fillerMode: FillerRemovalMode;
  customFillers: readonly string[];
  punctuationCommands: boolean;
  paragraphCommands: boolean;
  scratchCommands: boolean;
  capitalizeSentences: boolean;
  terminalPunctuation: TerminalPunctuationMode;
  normalizeWhitespace: boolean;
}

export type CleanupPresetName = "balanced" | "message" | "document" | "verbatim";

export interface AppCleanupProfile {
  /** A macOS bundle identifier or another stable application identifier. */
  appId: string;
  preset?: CleanupPresetName;
  overrides?: Partial<TextCleanupOptions>;
}

export interface TextTransformStats {
  removedFillers: number;
  punctuationCommands: number;
  paragraphCommands: number;
  backtracks: number;
}

export interface TextTransformResult {
  text: string;
  stats: TextTransformStats;
}

export interface FillerRemovalOptions {
  mode?: FillerRemovalMode;
  customFillers?: readonly string[];
  normalizeWhitespace?: boolean;
}

export interface SpokenCommandOptions {
  punctuationCommands?: boolean;
  paragraphCommands?: boolean;
  scratchCommands?: boolean;
  normalizeWhitespace?: boolean;
}
