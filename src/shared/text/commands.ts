import type { SpokenCommandOptions, TextTransformResult } from "./types";
import {
  cleanupTokenArtifacts,
  renderTokens,
  tokenizeText,
  wordSequenceAt,
  type TextToken,
} from "./tokens";

type CommandKind = "punctuation" | "paragraph" | "scratch";
type ScratchScope = "adaptive" | "word" | "sentence" | "paragraph";

interface SpokenCommand {
  words: readonly string[];
  kind: CommandKind;
  token?: TextToken;
  scratch?: ScratchScope;
}

const COMMANDS = ([
  { words: ["scratch", "last", "paragraph"], kind: "scratch", scratch: "paragraph" },
  { words: ["scratch", "previous", "paragraph"], kind: "scratch", scratch: "paragraph" },
  { words: ["scratch", "last", "sentence"], kind: "scratch", scratch: "sentence" },
  { words: ["scratch", "previous", "sentence"], kind: "scratch", scratch: "sentence" },
  { words: ["scratch", "last", "word"], kind: "scratch", scratch: "word" },
  { words: ["scratch", "previous", "word"], kind: "scratch", scratch: "word" },
  { words: ["scratch", "that"], kind: "scratch", scratch: "adaptive" },
  { words: ["never", "mind"], kind: "scratch", scratch: "adaptive" },
  { words: ["new", "paragraph"], kind: "paragraph", token: { kind: "break", lines: 2 } },
  { words: ["new", "line"], kind: "paragraph", token: { kind: "break", lines: 1 } },
  { words: ["open", "parenthesis"], kind: "punctuation", token: { kind: "punctuation", value: "(", role: "open" } },
  { words: ["open", "parentheses"], kind: "punctuation", token: { kind: "punctuation", value: "(", role: "open" } },
  { words: ["close", "parenthesis"], kind: "punctuation", token: { kind: "punctuation", value: ")", role: "close" } },
  { words: ["close", "parentheses"], kind: "punctuation", token: { kind: "punctuation", value: ")", role: "close" } },
  { words: ["open", "bracket"], kind: "punctuation", token: { kind: "punctuation", value: "[", role: "open" } },
  { words: ["close", "bracket"], kind: "punctuation", token: { kind: "punctuation", value: "]", role: "close" } },
  { words: ["open", "quote"], kind: "punctuation", token: { kind: "punctuation", value: "\u201c", role: "open" } },
  { words: ["close", "quote"], kind: "punctuation", token: { kind: "punctuation", value: "\u201d", role: "close" } },
  { words: ["question", "mark"], kind: "punctuation", token: { kind: "punctuation", value: "?", role: "close" } },
  { words: ["exclamation", "mark"], kind: "punctuation", token: { kind: "punctuation", value: "!", role: "close" } },
  { words: ["exclamation", "point"], kind: "punctuation", token: { kind: "punctuation", value: "!", role: "close" } },
  { words: ["full", "stop"], kind: "punctuation", token: { kind: "punctuation", value: ".", role: "close" } },
  { words: ["em", "dash"], kind: "punctuation", token: { kind: "punctuation", value: "\u2014", role: "dash" } },
  { words: ["comma"], kind: "punctuation", token: { kind: "punctuation", value: ",", role: "close" } },
  { words: ["period"], kind: "punctuation", token: { kind: "punctuation", value: ".", role: "close" } },
  { words: ["colon"], kind: "punctuation", token: { kind: "punctuation", value: ":", role: "close" } },
  { words: ["semicolon"], kind: "punctuation", token: { kind: "punctuation", value: ";", role: "close" } },
  { words: ["dash"], kind: "punctuation", token: { kind: "punctuation", value: "\u2014", role: "dash" } },
  { words: ["hyphen"], kind: "punctuation", token: { kind: "punctuation", value: "-", role: "joiner" } },
  { words: ["slash"], kind: "punctuation", token: { kind: "punctuation", value: "/", role: "joiner" } },
] satisfies SpokenCommand[]).sort((left, right) => right.words.length - left.words.length);

function commandEnabled(command: SpokenCommand, options: Required<SpokenCommandOptions>): boolean {
  if (command.kind === "punctuation") return options.punctuationCommands;
  if (command.kind === "paragraph") return options.paragraphCommands;
  return options.scratchCommands;
}

function trimTrailingBreaks(tokens: TextToken[]): void {
  while (tokens.at(-1)?.kind === "break") tokens.pop();
}

function isStrongBoundary(token: TextToken | undefined): boolean {
  return token?.kind === "punctuation" && /^[.!?]$/u.test(token.value);
}

function isTrailingCloser(token: TextToken | undefined): boolean {
  return (
    token?.kind === "punctuation" &&
    (token.role === "close" || /^[\u201d"')}\]]$/u.test(token.value)) &&
    !isStrongBoundary(token)
  );
}

function adaptiveScratchUsesSentenceScope(tokens: readonly TextToken[]): boolean {
  let index = tokens.length - 1;
  while (index >= 0 && isTrailingCloser(tokens[index])) index -= 1;
  return isStrongBoundary(tokens[index]);
}

function removeLastWord(tokens: TextToken[]): void {
  trimTrailingBreaks(tokens);
  while (tokens.at(-1)?.kind === "punctuation") tokens.pop();
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index]?.kind === "word") {
      tokens.splice(index, 1);
      break;
    }
  }
}

function removeLastSentence(tokens: TextToken[]): void {
  trimTrailingBreaks(tokens);
  let terminalIndex = tokens.length - 1;
  while (terminalIndex >= 0 && isTrailingCloser(tokens[terminalIndex])) terminalIndex -= 1;
  const completedSentence = isStrongBoundary(tokens[terminalIndex]);

  let start = 0;
  for (
    let index = completedSentence ? terminalIndex - 1 : tokens.length - 1;
    index >= 0;
    index -= 1
  ) {
    const token = tokens[index];
    if (isStrongBoundary(token)) {
      start = index + 1;
      break;
    }
    if (token?.kind === "break" && token.lines === 2) {
      start = index + 1;
      break;
    }
  }
  tokens.splice(start);
  trimTrailingBreaks(tokens);
}

function removeLastParagraph(tokens: TextToken[]): void {
  trimTrailingBreaks(tokens);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token?.kind === "break" && token.lines === 2) {
      tokens.splice(index + 1);
      return;
    }
  }
  tokens.splice(0);
}

function applyScratch(tokens: TextToken[], scope: ScratchScope): void {
  trimTrailingBreaks(tokens);
  if (scope === "paragraph") return removeLastParagraph(tokens);
  if (scope === "sentence") return removeLastSentence(tokens);
  if (scope === "word") return removeLastWord(tokens);
  if (adaptiveScratchUsesSentenceScope(tokens)) return removeLastSentence(tokens);
  return removeLastWord(tokens);
}

export function applySpokenCommands(
  text: string,
  options: SpokenCommandOptions = {},
): TextTransformResult {
  const resolved: Required<SpokenCommandOptions> = {
    punctuationCommands: options.punctuationCommands ?? true,
    paragraphCommands: options.paragraphCommands ?? true,
    scratchCommands: options.scratchCommands ?? true,
    normalizeWhitespace: options.normalizeWhitespace ?? true,
  };
  if (
    !resolved.punctuationCommands &&
    !resolved.paragraphCommands &&
    !resolved.scratchCommands &&
    !resolved.normalizeWhitespace
  ) {
    return {
      text,
      stats: { removedFillers: 0, punctuationCommands: 0, paragraphCommands: 0, backtracks: 0 },
    };
  }
  const tokens = tokenizeText(text);
  const output: TextToken[] = [];
  let punctuationCommands = 0;
  let paragraphCommands = 0;
  let backtracks = 0;

  for (let index = 0; index < tokens.length; ) {
    const command = COMMANDS.find(
      (candidate) =>
        commandEnabled(candidate, resolved) && wordSequenceAt(tokens, index, candidate.words),
    );

    if (!command) {
      output.push(tokens[index]!);
      index += 1;
      continue;
    }

    index += command.words.length;
    if (command.kind === "scratch") {
      applyScratch(output, command.scratch ?? "adaptive");
      backtracks += 1;
    } else if (command.token) {
      output.push({ ...command.token });
      if (command.kind === "paragraph") paragraphCommands += 1;
      else punctuationCommands += 1;
    }
  }

  return {
    text: renderTokens(cleanupTokenArtifacts(output), resolved.normalizeWhitespace),
    stats: { removedFillers: 0, punctuationCommands, paragraphCommands, backtracks },
  };
}
