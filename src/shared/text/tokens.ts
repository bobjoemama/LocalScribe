export type TextToken =
  | { kind: "word"; value: string }
  | { kind: "punctuation"; value: string; role?: "open" | "close" | "joiner" | "dash" }
  | { kind: "break"; lines: 1 | 2 };

const TOKEN_PATTERN = /\r\n|\r|\n|[\p{L}\p{M}\p{N}]+(?:['\u2019-][\p{L}\p{M}\p{N}]+)*|[^\s]/gu;

export function tokenizeText(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  let pendingBreaks = 0;

  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const value = match[0];
    if (value === "\n" || value === "\r" || value === "\r\n") {
      pendingBreaks += 1;
      continue;
    }

    if (pendingBreaks > 0) {
      tokens.push({ kind: "break", lines: pendingBreaks > 1 ? 2 : 1 });
      pendingBreaks = 0;
    }

    if (/^[\p{L}\p{M}\p{N}]/u.test(value)) tokens.push({ kind: "word", value });
    else tokens.push({ kind: "punctuation", value });
  }

  if (pendingBreaks > 0) tokens.push({ kind: "break", lines: pendingBreaks > 1 ? 2 : 1 });
  return tokens;
}

export function isWord(token: TextToken | undefined): token is Extract<TextToken, { kind: "word" }> {
  return token?.kind === "word";
}

export function wordSequenceAt(
  tokens: readonly TextToken[],
  index: number,
  phrase: readonly string[],
): boolean {
  if (index + phrase.length > tokens.length) return false;
  for (let offset = 0; offset < phrase.length; offset += 1) {
    const token = tokens[index + offset];
    if (!isWord(token) || token.value.toLocaleLowerCase("en-US") !== phrase[offset]) return false;
  }
  return true;
}

function isClosingPunctuation(token: TextToken): boolean {
  return (
    token.kind === "punctuation" &&
    (token.role === "close" || /^[,.;:!?%\)\]\}]$/u.test(token.value))
  );
}

function isOpeningPunctuation(token: TextToken): boolean {
  return (
    token.kind === "punctuation" &&
    (token.role === "open" || /^[\(\[\{]$/u.test(token.value))
  );
}

function isJoiner(token: TextToken): boolean {
  return token.kind === "punctuation" && (token.role === "joiner" || token.value === "/");
}

export function renderTokens(tokens: readonly TextToken[], normalizeWhitespace = true): string {
  if (tokens.length === 0) return "";

  let output = "";
  let previous: TextToken | undefined;

  for (const token of tokens) {
    if (token.kind === "break") {
      output = output.trimEnd() + (token.lines === 2 ? "\n\n" : "\n");
      previous = token;
      continue;
    }

    if (token.kind === "punctuation" && token.role === "dash") {
      output = output.trimEnd();
      if (output.length > 0 && !output.endsWith("\n")) output += " ";
      output += token.value;
      output += " ";
      previous = token;
      continue;
    }

    if (isClosingPunctuation(token) || isJoiner(token)) {
      output = output.trimEnd() + token.value;
      previous = token;
      continue;
    }

    const joinsPrevious = previous !== undefined && (isOpeningPunctuation(previous) || isJoiner(previous));
    const needsSpace =
      output.length > 0 &&
      !output.endsWith(" ") &&
      !output.endsWith("\n") &&
      !joinsPrevious;
    if (needsSpace) output += " ";
    output += token.value;
    previous = token;
  }

  const trimmed = output.trim();
  if (!normalizeWhitespace) return trimmed;
  return trimmed
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

export function cleanupTokenArtifacts(tokens: readonly TextToken[]): TextToken[] {
  const output: TextToken[] = [];

  for (const token of tokens) {
    const previous = output.at(-1);
    if (
      token.kind === "punctuation" &&
      token.value === "," &&
      previous?.kind === "punctuation" &&
      previous.value === ","
    ) {
      continue;
    }
    if (token.kind === "break" && previous?.kind === "break") {
      previous.lines = Math.max(previous.lines, token.lines) as 1 | 2;
      continue;
    }
    output.push({ ...token });
  }

  while (output[0]?.kind === "punctuation" && output[0].value === ",") output.shift();
  for (;;) {
    const last = output.at(-1);
    if (last?.kind !== "punctuation" || last.value !== ",") break;
    output.pop();
  }
  return output;
}
