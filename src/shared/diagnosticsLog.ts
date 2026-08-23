/**
 * The shape of LocalScribe's durable failure trail, and the rules that keep it
 * safe to hand to someone else.
 *
 * The packaged app runs with stdout and stderr pointing at /dev/null and writes
 * nothing to the macOS unified log, so when dictation failed there was no
 * evidence anywhere on the machine about which stage failed. Every diagnosis
 * had to start by rebuilding the app with a console attached, which changes the
 * very thing being diagnosed.
 *
 * The hard constraint is that this file must stay safe to attach to a bug
 * report on a machine that dictates medical notes, passwords, or private
 * correspondence. So the writer is not a general-purpose logger: it accepts a
 * closed set of events with a closed set of fields, and every field is either a
 * number, a boolean, an enum member, or an opaque identifier. There is no
 * free-text field a caller could accidentally fill with a transcript.
 *
 * This module is pure so the redaction rules can be tested without a filesystem
 * or an Electron app; `src/main/diagnostics/diagnosticsRecorder.ts` owns the
 * rotation and the actual writes.
 */

/** Stages of a dictation, in the order a successful run visits them. */
export const DIAGNOSTIC_STAGES = [
  "hotkey",
  "session",
  "recorder",
  "permission",
  "encode",
  "ipc",
  "model",
  "worker",
  "insertion",
  "cleanup",
  "lifecycle",
] as const;

export type DiagnosticStage = (typeof DIAGNOSTIC_STAGES)[number];

export type DiagnosticOutcome = "ok" | "failed" | "cancelled" | "skipped";

/**
 * One diagnostic record.
 *
 * Every field here is deliberately non-content. `sessionId` is a UUID the app
 * generated for one dictation; it identifies a run in this file and nothing
 * outside it. `detail` is a NORMALIZED ERROR CODE, never an error message —
 * `normalizeDiagnosticCode` below is what enforces that, because raw error
 * messages routinely contain file paths, and file paths contain the user's
 * name.
 */
export interface DiagnosticEvent {
  readonly at: number;
  readonly stage: DiagnosticStage;
  readonly event: string;
  readonly outcome: DiagnosticOutcome;
  readonly sessionId?: string;
  readonly durationMs?: number;
  readonly detail?: string;
  readonly modelFamily?: string;
  readonly modelTier?: string;
  readonly hotkeyMode?: string;
  readonly permission?: string;
  readonly count?: number;
}

/** Build identity, written once at the head of every diagnostics file. */
export interface DiagnosticBuildIdentity {
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly electron: string;
  readonly sourceRoot?: string;
}

/**
 * The only characters an event name, code, or enum-ish field may contain.
 *
 * Anything outside this set is dropped rather than escaped: a value that needed
 * escaping was not one of the closed-set values this format accepts, and
 * passing it through would be exactly the leak this module exists to prevent.
 */
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/u;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Reduce an arbitrary thrown value to a short, non-identifying code.
 *
 * Error messages in this app carry absolute paths (`/Users/<name>/Library/...`),
 * model URLs, and occasionally the text being inserted. None of that may reach
 * the file, so the message is never used directly: a known error is mapped to
 * its code, and everything else becomes the error's constructor name plus a
 * length, which is enough to distinguish "the same failure every time" from
 * "a different failure each time" without revealing what it said.
 */
export function normalizeDiagnosticCode(error: unknown): string {
  if (typeof error === "string" && SAFE_TOKEN.test(error)) return error;
  const known = knownCodeFor(error);
  if (known !== undefined) return known;
  if (error instanceof Error) return `${error.name || "Error"}:len${error.message.length}`;
  if (error === undefined) return "undefined";
  if (error === null) return "null";
  return `${typeof error}`;
}

/**
 * The known code carried by an error, its `code` property, or any error it wraps.
 *
 * Three separate reasons this is not "the first lowercase word in the message":
 *
 *   - main rewraps a worker failure in a sentence the user can act on and
 *     passes the original as `cause`, so the only copy of the code was in a
 *     field nothing looked at;
 *   - "ASR worker exited (1)" begins with `worker`, so the scan stopped on a
 *     word that is not a code and never reached one;
 *   - the supervisor's own failures are facts about the process, not words in
 *     a sentence, so they carry `code` instead.
 *
 * Only members of the closed set are ever returned, so widening what is
 * searched cannot widen what is written.
 */
function knownCodeFor(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = error;
  // Bounded, and cycle-safe: `cause` is attacker-shaped input as far as this
  // module is concerned, and a diagnostics writer must never be the thing that
  // hangs the app.
  for (let depth = 0; depth < 8 && current instanceof Error && !seen.has(current); depth += 1) {
    seen.add(current);
    const tagged = (current as { code?: unknown }).code;
    if (typeof tagged === "string" && KNOWN_ERROR_CODES.has(tagged)) return tagged;
    for (const match of current.message.matchAll(/\b([a-z][a-z0-9_]{2,40})\b/gu)) {
      const token = match[1];
      if (token !== undefined && KNOWN_ERROR_CODES.has(token)) return token;
    }
    current = current.cause;
  }
  return undefined;
}

/**
 * Worker and main-process error codes that are safe to record verbatim.
 *
 * These are protocol constants, not user data. Keeping an explicit set is what
 * lets `normalizeDiagnosticCode` return something readable for the failures we
 * already understand while still refusing to echo an arbitrary message.
 */
export const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  "model_not_installed",
  "model_verification_failed",
  "model_load_failed",
  "internal_error",
  "invalid_request",
  "unsupported_model",
  "download_failed",
  "audio_too_long",
  "audio_invalid",
  "worker_exited",
  "worker_timeout",
  "permission_denied",
  "not_permitted",
  "no_speech_detected",
  "cancelled",
]);

function safeToken(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : undefined;
}

function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/**
 * Force one event through the field allowlist.
 *
 * Callers pass a plain object; anything not named here is discarded, and every
 * named field is range- or pattern-checked. This is the single choke point, so
 * a future caller cannot introduce a leak by adding a property.
 */
export function sanitizeDiagnosticEvent(input: DiagnosticEvent): DiagnosticEvent {
  const sanitized: {
    -readonly [K in keyof DiagnosticEvent]: DiagnosticEvent[K];
  } = {
    at: Number.isFinite(input.at) ? Math.round(input.at) : 0,
    stage: DIAGNOSTIC_STAGES.includes(input.stage) ? input.stage : "lifecycle",
    event: safeToken(input.event) ?? "unknown",
    outcome: (["ok", "failed", "cancelled", "skipped"] as const).includes(input.outcome)
      ? input.outcome
      : "failed",
  };
  // A session id is only kept when it is genuinely a generated UUID. A caller
  // that passed something else was passing something that is not an id.
  if (typeof input.sessionId === "string" && UUID.test(input.sessionId)) {
    sanitized.sessionId = input.sessionId.toLowerCase();
  }
  const durationMs = safeCount(input.durationMs);
  if (durationMs !== undefined) sanitized.durationMs = durationMs;
  const count = safeCount(input.count);
  if (count !== undefined) sanitized.count = count;
  for (const key of ["detail", "modelFamily", "modelTier", "hotkeyMode", "permission"] as const) {
    const token = safeToken(input[key]);
    if (token !== undefined) sanitized[key] = token;
  }
  return sanitized;
}

/** One JSON object per line, so a truncated file still parses up to the cut. */
export function formatDiagnosticLine(event: DiagnosticEvent): string {
  return `${JSON.stringify(sanitizeDiagnosticEvent(event))}\n`;
}

export function formatDiagnosticHeader(identity: DiagnosticBuildIdentity): string {
  return `${JSON.stringify({
    kind: "localscribe-diagnostics",
    formatVersion: 1,
    version: safeToken(identity.version) ?? "unknown",
    platform: safeToken(identity.platform) ?? "unknown",
    arch: safeToken(identity.arch) ?? "unknown",
    electron: safeToken(identity.electron) ?? "unknown",
    ...(safeToken(identity.sourceRoot) ? { sourceRoot: identity.sourceRoot } : {}),
  })}\n`;
}

/**
 * Patterns that must never appear in the diagnostics file.
 *
 * The allowlist above is the actual defence; this is the assertion that proves
 * it worked, and it is what the test suite runs over generated output. A
 * regression that widened a field would show up here as a failing test rather
 * than as a support attachment containing someone's dictation.
 */
export const FORBIDDEN_DIAGNOSTIC_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "home directory path", pattern: /\/Users\/[^/\s"]+/u },
  { name: "absolute posix path", pattern: /"[^"]*\/[^"]*\/[^"]*"/u },
  { name: "drive-letter path", pattern: /[A-Za-z]:\\\\/u },
  { name: "url", pattern: /https?:\/\//u },
  { name: "bearer token", pattern: /bearer\s+\S+/iu },
  { name: "long free text", pattern: /"[^"]{65,}"/u },
];

/** Throws when generated diagnostics content violates the redaction rules. */
export function assertRedacted(content: string): void {
  for (const { name, pattern } of FORBIDDEN_DIAGNOSTIC_PATTERNS) {
    const match = pattern.exec(content);
    if (match) {
      throw new Error(`diagnostics content contains a ${name}: ${match[0].slice(0, 24)}`);
    }
  }
}
