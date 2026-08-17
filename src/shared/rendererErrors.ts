const DEFAULT_RENDERER_ERROR_MESSAGE = "The local operation failed. Try again.";
const MAX_RENDERER_ERROR_LENGTH = 160;

const PRIVATE_PATH_PATTERN = /(?:file:\/\/|https?:\/\/|[A-Za-z]:[\\/]|\\\\|%(?:APPDATA|HOME|HOMEPATH|LOCALAPPDATA|PROFILE|PROGRAMDATA|TEMP|TMP|USERPROFILE)%[\\/]|(?:\$HOME|\$\{HOME\}|\$TMPDIR|\$\{TMPDIR\}|~)[\\/]|\/(?:Applications|Library|Users|Volumes|dev|etc|home|mnt\/[a-z]|opt|private|proc|root|run|srv|sys|tmp|usr|var)(?:\/|$)|(?:^|[\s("'=])\/(?!\/)(?:[^/\s"'<>]+\/)+[^/\s"'<>]*)/i;
const TECHNICAL_DETAIL_PATTERN = /(?:^\s*[[{]|\b(?:Command failed|EACCES|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|EISDIR|ENETUNREACH|ENOENT|ENOTDIR|EPERM|ERR_[A-Z0-9_]+|ETIMEDOUT|Invalid input: expected|SQLITE_[A-Z0-9_]+|Traceback|UnhandledPromiseRejection)\b|\b(?:RangeError|ReferenceError|SyntaxError|TypeError):|node:internal|(?:^|[\r\n])\s*at\s+|File\s+"[^"]+",\s+line\s+\d+|\bat\s+(?:async\s+)?\S+.*:\d+(?::\d+)?|\b[\w.-]+\.(?:[cm]?[jt]sx?|cpp|py|swift):\d+(?::\d+)?\b|\b(?:child process|execFile|invalid JSON|spawn)\b|\b(?:ASR\s+|speech\s+)?worker\b.*\b(?:did not start|exited|not running|protocol|request|response|stderr|stdout|timed out)\b|\b(?:bundled\s+)?Python runtime\b)/i;
/* Error-code tokens are for diagnostics, not a person-facing sentence. */
const INTERNAL_ERROR_CODE_PATTERN = /(?:^|\s)[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?:\s*:|\s|$)/i;

function compactMessage(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function boundedMessage(value: string): string {
  return value.length > MAX_RENDERER_ERROR_LENGTH
    ? `${value.slice(0, MAX_RENDERER_ERROR_LENGTH - 3)}...`
    : value;
}

function unwrapErrorEnvelope(value: string): string {
  return value
    .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, "")
    .replace(/^(?:Error:\s*)+/i, "");
}

function containsPrivateOrTechnicalDetail(value: string): boolean {
  return PRIVATE_PATH_PATTERN.test(value)
    || TECHNICAL_DETAIL_PATTERN.test(value)
    || INTERNAL_ERROR_CODE_PATTERN.test(value);
}

/**
 * Converts rejected IPC and local-operation errors into renderer-safe copy.
 * Technical diagnostics remain available to the main process and logs; visible
 * renderer surfaces receive only concise messages without machine-local paths.
 */
export function rendererSafeErrorMessage(
  error: unknown,
  fallback = DEFAULT_RENDERER_ERROR_MESSAGE,
): string {
  const compactFallback = compactMessage(fallback) || DEFAULT_RENDERER_ERROR_MESSAGE;
  const safeFallback = containsPrivateOrTechnicalDetail(compactFallback)
    ? DEFAULT_RENDERER_ERROR_MESSAGE
    : boundedMessage(compactFallback);
  const raw = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
  const compact = compactMessage(unwrapErrorEnvelope(raw));
  if (!compact || containsPrivateOrTechnicalDetail(raw) || containsPrivateOrTechnicalDetail(compact)) {
    return safeFallback;
  }
  return boundedMessage(compact);
}
