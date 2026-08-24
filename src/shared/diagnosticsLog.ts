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

/** Every event name emitted by the current main-process call sites. */
export const DIAGNOSTIC_EVENTS = [
  "auto_tier_held",
  "begin_listening",
  "copied",
  "fallback_register",
  "finalize_watchdog",
  "global_register",
  "history_export_partial",
  "history_retention",
  "history_save",
  "install",
  "pasted",
  "pasted-with-copy",
  "renderer_failure",
  "startup",
  "shutdown",
  "switch_refused",
  "temporary_audio_remove",
  "toggle_register",
  "transcribe",
  "transcribe_admission",
  "transcribe_payload",
  "transcribe_prelude",
  "unknown_event",
] as const;

export const DIAGNOSTIC_OUTCOMES = ["ok", "failed", "cancelled", "skipped"] as const;

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
 * Strict structural formats for identifiers that cannot come from user text.
 * Every enum-like event field uses an explicit vocabulary below instead.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-dev\.\d{1,6})?$/u;
const ELECTRON_VERSION = /^(?:unknown|\d{1,4}\.\d{1,4}\.\d{1,4})$/u;

/**
 * Reduce an arbitrary thrown value to a short, non-identifying code.
 *
 * Error messages in this app carry absolute paths (`/Users/<name>/Library/...`),
 * model URLs, and occasionally the text being inserted. None of that may reach
 * the file, so the message is never echoed: a known error is mapped to its
 * closed code, and everything else becomes the same `unknown_error` token.
 */
export function normalizeDiagnosticCode(error: unknown): string {
  if (typeof error === "string" && KNOWN_ERROR_CODES.has(error)) return error;
  const known = knownCodeFor(error);
  if (known !== undefined) return known;
  // Do not encode the constructor, type, or message length. All three are
  // attacker-shaped metadata and a short secret must be indistinguishable
  // from any other unrecognised failure.
  return "unknown_error";
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
    if (current.message === "No speech detected") return "no_speech_detected";
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
  "allow_download_not_allowed",
  "allow_download_required",
  "apple_silicon_only",
  "audio_path_not_allowed",
  "device_info_unavailable",
  "invalid_asr_mode",
  "invalid_audio_file",
  "invalid_audio_format",
  "invalid_audio_path",
  "invalid_context",
  "invalid_json",
  "invalid_language",
  "invalid_mode",
  "invalid_model_manifest",
  "invalid_model_output",
  "invalid_model_root",
  "model_not_installed",
  "internal_error",
  "invalid_request",
  "invalid_request_id",
  "live_session_active",
  "live_session_not_started",
  "model_activation_failed",
  "model_checksum_failed",
  "model_download_failed",
  "model_load_failed",
  "model_not_allowed",
  "model_not_loaded",
  "model_path_changed",
  "model_recovery_failed",
  "model_verification_failed",
  "parakeet_runtime_failed",
  "runtime_import_failed",
  "runtime_protocol_error",
  "runtime_unavailable",
  "transcription_failed",
  "unsafe_model_path",
  "unsupported_message_type",
  "worker_exited",
  "worker_timeout",
  "no_speech_detected",
  "cancelled",
]);

const INSERTION_DIAGNOSTIC_DETAILS = [
  "automatic_paste_disabled",
  "automatic_paste_unavailable",
  "session_invalidated",
  "initial_target_unavailable",
  "initial_target_editability_unavailable",
  "initial_target_not_editable",
  "initial_window_identity_unavailable",
  "initial_control_identity_unavailable",
  "current_target_unavailable",
  "current_target_editability_unavailable",
  "current_target_not_editable",
  "current_window_identity_unavailable",
  "current_window_changed",
  "current_control_identity_unavailable",
  "current_control_changed",
  "app_process_target_changed",
  "clipboard_snapshot_failed",
  "clipboard_sequence_unavailable",
  "paste_injection_failed",
  "paste_acknowledgement_unavailable",
  "paste_acknowledgement_failed",
  "target_unavailable",
  "target_changed",
  "clipboard_changed",
  "event_unavailable",
  "helper_unavailable",
  "invalid_response",
] as const;

/** Closed detail vocabulary from normalizers and literal diagnostic call sites. */
export const DIAGNOSTIC_DETAILS: ReadonlySet<string> = new Set([
  ...KNOWN_ERROR_CODES,
  ...INSERTION_DIAGNOSTIC_DETAILS,
  "model_verification_failed",
  "permission_denied",
  "model_selection_mismatch",
  "renderer_load_failed",
  "renderer_process_gone",
  "unknown_error",
]);

const DIAGNOSTIC_EVENT_SET: ReadonlySet<string> = new Set(DIAGNOSTIC_EVENTS);
const DIAGNOSTIC_OUTCOME_SET: ReadonlySet<string> = new Set(DIAGNOSTIC_OUTCOMES);
const MODEL_FAMILIES: ReadonlySet<string> = new Set([
  "parakeet-unified-en-0-6b",
  "whisper-large-v3",
  "qwen3-asr-0-6b",
  "qwen3-asr-1-7b",
  "whisper-large-v2",
]);
const MODEL_TIERS: ReadonlySet<string> = new Set(["high", "medium", "low"]);
const HOTKEY_MODES: ReadonlySet<string> = new Set(["hold", "toggle"]);
const PERMISSIONS: ReadonlySet<string> = new Set([
  "accessibility_denied",
  "disabled",
  "not_ready",
  "ready",
]);

function memberOf(value: unknown, vocabulary: ReadonlySet<string>): string | undefined {
  return typeof value === "string" && vocabulary.has(value) ? value : undefined;
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
    event: memberOf(input.event, DIAGNOSTIC_EVENT_SET) ?? "unknown_event",
    outcome: memberOf(input.outcome, DIAGNOSTIC_OUTCOME_SET) as DiagnosticOutcome | undefined
      ?? "failed",
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
  const detail = memberOf(input.detail, DIAGNOSTIC_DETAILS);
  if (detail !== undefined) sanitized.detail = detail;
  const modelFamily = memberOf(input.modelFamily, MODEL_FAMILIES);
  if (modelFamily !== undefined) sanitized.modelFamily = modelFamily;
  const modelTier = memberOf(input.modelTier, MODEL_TIERS);
  if (modelTier !== undefined) sanitized.modelTier = modelTier;
  const hotkeyMode = memberOf(input.hotkeyMode, HOTKEY_MODES);
  if (hotkeyMode !== undefined) sanitized.hotkeyMode = hotkeyMode;
  const permission = memberOf(input.permission, PERMISSIONS);
  if (permission !== undefined) sanitized.permission = permission;
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
    version: VERSION.test(identity.version) ? identity.version : "unknown",
    platform: memberOf(identity.platform, new Set(["darwin"])) ?? "unknown",
    arch: memberOf(identity.arch, new Set(["arm64", "x64"])) ?? "unknown",
    electron: ELECTRON_VERSION.test(identity.electron) ? identity.electron : "unknown",
    ...(typeof identity.sourceRoot === "string" && /^[0-9a-f]{40}$/u.test(identity.sourceRoot)
      ? { sourceRoot: identity.sourceRoot }
      : {}),
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
