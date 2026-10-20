import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NativeHelperCommand, NativeHelperFailure } from "../../shared/diagnosticsLog";
import {
  resolveNativeActiveTargetHelperPath,
  type NativeActiveTargetHelperPathOptions,
} from "../nativeHelperPath";
import { nativeHelperEnvironment } from "../nativeHelperEnvironment";
import {
  digestRegularExecutable,
  proveRegularExecutable,
  sameRegularExecutableProof,
  sameExecutableAuthority,
  type ExecutableProofReader,
  type RegularExecutableProof,
} from "./nativeExecutableIntegrity";
import {
  ACCESSIBILITY_ACTIVATION_OUTCOMES,
  ACCESSIBILITY_ELEMENT_CATEGORIES,
} from "./types";
import type {
  ActiveTarget,
  AccessibilityStatus,
  InsertionDiagnosticCallback,
  NativeInsertionDiagnostic,
  PasteFailureReason,
  PasteInjectionResult,
  PlatformInsertionBridge,
} from "./types";

const execFileAsync = promisify(execFile);

const DEFAULT_HELPER_TIMEOUT_MS = 1_000;
// A target lookup can spend two seconds recovering a cold Chromium tree.
// Leave process-startup and JSON-encoding margin beyond that native bound.
const TARGET_HELPER_TIMEOUT_MS = 3_500;
// Paste captures the target twice before posting Command-V. Each capture may
// independently exercise the full cold-tree recovery bound.
const PASTE_HELPER_TIMEOUT_MS = 6_000;
const REQUEST_ACCESSIBILITY_TIMEOUT_MS = 15_000;

function helperTimeoutForCommand(command: string | undefined): number {
  switch (command) {
    case "target":
      return TARGET_HELPER_TIMEOUT_MS;
    case "paste":
      return PASTE_HELPER_TIMEOUT_MS;
    case "request-accessibility":
      return REQUEST_ACCESSIBILITY_TIMEOUT_MS;
    default:
      return DEFAULT_HELPER_TIMEOUT_MS;
  }
}

interface HelperTargetPayload {
  platform?: unknown;
  processId?: unknown;
  applicationId?: unknown;
  windowFingerprint?: unknown;
  focusedEditable?: unknown;
  focusedElementFingerprint?: unknown;
  accessibilityElement?: unknown;
  accessibilityActivation?: unknown;
  accessibilityLookupAttempts?: unknown;
}

interface HelperAccessibilityPayload {
  accessibility?: unknown;
  postEvents?: unknown;
}

function parseAccessibilityPermissions(raw: string): {
  accessibilityTrusted: boolean;
  postEventsAllowed: boolean;
} | null {
  try {
    const payload = JSON.parse(raw) as HelperAccessibilityPayload;
    if (typeof payload?.accessibility !== "boolean" || typeof payload.postEvents !== "boolean") {
      return null;
    }
    return { accessibilityTrusted: payload.accessibility, postEventsAllowed: payload.postEvents };
  } catch {
    return null;
  }
}

function parseAccessibilityStatus(raw: string): AccessibilityStatus {
  const permissions = parseAccessibilityPermissions(raw);
  return permissions === null ? "unavailable"
    : permissions.accessibilityTrusted && permissions.postEventsAllowed ? "granted" : "denied";
}

function executionFailure(error: unknown): NativeHelperFailure {
  // Never read messages, invoke getters, or coerce arbitrary code/signal values.
  // Node's execFile errors carry these process facts as own data properties.
  try {
    if (typeof error !== "object" || error === null) return "spawn_failure";
    const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
    const killed: unknown = Object.getOwnPropertyDescriptor(error, "killed")?.value;
    const signal: unknown = Object.getOwnPropertyDescriptor(error, "signal")?.value;
    if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "invalid_response";
    if (code === "ETIMEDOUT" || (killed === true && signal === "SIGTERM")) return "timeout";
    if (typeof code === "number" || typeof signal === "string") return "exit_failure";
  } catch {
    // Even a descriptor proxy trap must not break insertion or leak its error.
  }
  return "spawn_failure";
}

function parseAccessibility(raw: string): boolean {
  return parseAccessibilityStatus(raw) === "granted";
}

function parsePaste(raw: string): PasteInjectionResult {
  try {
    const payload = JSON.parse(raw) as { injected?: unknown; reason?: unknown };
    if (payload.injected === true) return { status: "injected" };
    const failureReasons = new Set<PasteFailureReason>([
      "permission_denied",
      "target_unavailable",
      "target_changed",
      "clipboard_changed",
      "event_unavailable",
    ]);
    return payload.injected === false
      && typeof payload.reason === "string"
      && failureReasons.has(payload.reason as PasteFailureReason)
      ? { status: "failed", reason: payload.reason as PasteFailureReason }
      : { status: "failed", reason: "invalid_response" };
  } catch {
    return { status: "failed", reason: "invalid_response" };
  }
}

function parseTarget(raw: string): ActiveTarget | null {
  let payload: HelperTargetPayload;
  try {
    payload = JSON.parse(raw) as HelperTargetPayload;
  } catch {
    return null;
  }

  if (
    payload === null || typeof payload !== "object" ||
    payload.platform !== "darwin" ||
    !Number.isSafeInteger(payload.processId) ||
    (payload.processId as number) <= 0 ||
    typeof payload.applicationId !== "string" ||
    payload.applicationId.length === 0 ||
    payload.applicationId.length > 1_024 ||
    (payload.windowFingerprint !== null && typeof payload.windowFingerprint !== "string") ||
    (payload.focusedEditable !== null && typeof payload.focusedEditable !== "boolean") ||
    (
      payload.focusedElementFingerprint !== null
      && typeof payload.focusedElementFingerprint !== "string"
    )
  ) {
    return null;
  }

  const windowFingerprint = payload.windowFingerprint as string | null;
  if (windowFingerprint !== null && !/^[a-f0-9]{64}$/i.test(windowFingerprint)) return null;
  const focusedElementFingerprint = payload.focusedElementFingerprint as string | null;
  if (
    focusedElementFingerprint !== null &&
    !/^[a-f0-9]{64}$/i.test(focusedElementFingerprint)
  ) {
    return null;
  }

  const hasAccessibilityDiagnostics = payload.accessibilityElement !== undefined
    || payload.accessibilityActivation !== undefined
    || payload.accessibilityLookupAttempts !== undefined;
  if (hasAccessibilityDiagnostics && (
    typeof payload.accessibilityElement !== "string"
    || !ACCESSIBILITY_ELEMENT_CATEGORIES.includes(
      payload.accessibilityElement as (typeof ACCESSIBILITY_ELEMENT_CATEGORIES)[number],
    )
    || typeof payload.accessibilityActivation !== "string"
    || !ACCESSIBILITY_ACTIVATION_OUTCOMES.includes(
      payload.accessibilityActivation as (typeof ACCESSIBILITY_ACTIVATION_OUTCOMES)[number],
    )
    || !Number.isSafeInteger(payload.accessibilityLookupAttempts)
    || (payload.accessibilityLookupAttempts as number) < 0
    || (payload.accessibilityLookupAttempts as number) > 81
  )) {
    return null;
  }

  const target: ActiveTarget = {
    platform: payload.platform,
    processId: payload.processId as number,
    applicationId: payload.applicationId,
    windowFingerprint,
  };
  target.focusedEditable = payload.focusedEditable as boolean | null;
  target.focusedElementFingerprint = focusedElementFingerprint;
  if (hasAccessibilityDiagnostics) {
    target.accessibilityElement = payload.accessibilityElement as
      (typeof ACCESSIBILITY_ELEMENT_CATEGORIES)[number];
    target.accessibilityActivation = payload.accessibilityActivation as
      (typeof ACCESSIBILITY_ACTIVATION_OUTCOMES)[number];
    target.accessibilityLookupAttempts = payload.accessibilityLookupAttempts as number;
  }
  return target;
}

function pasteArguments(
  target: ActiveTarget,
  expectedClipboardSequence: number,
): string[] | null {
  if (!target || typeof target !== "object") return null;
  if (
    target.platform !== "darwin" ||
    !Number.isSafeInteger(target.processId) ||
    target.processId <= 0 ||
    target.processId > 2_147_483_647 ||
    typeof target.applicationId !== "string" ||
    target.applicationId.length === 0 ||
    Buffer.byteLength(target.applicationId, "utf8") > 1_024 ||
    target.applicationId.includes("\0") ||
    typeof target.windowFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(target.windowFingerprint) ||
    !Number.isSafeInteger(expectedClipboardSequence) ||
    expectedClipboardSequence < 0
  ) {
    return null;
  }
  if (
    typeof target.focusedElementFingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(target.focusedElementFingerprint)
  ) {
    return null;
  }

  const arguments_ = [
    "paste",
    target.platform,
    String(target.processId),
    target.applicationId,
    target.windowFingerprint,
  ];
  arguments_.push(target.focusedElementFingerprint);
  arguments_.push(String(expectedClipboardSequence));
  return arguments_;
}

export class NativeExecutableInsertionBridge implements PlatformInsertionBridge {
  private readiness: Promise<boolean> | null = null;
  private pinnedProof: RegularExecutableProof | null;
  private lastPermissions: string | null = null;

  constructor(
    private readonly executablePath: string,
    private readonly proveExecutable: ExecutableProofReader = proveRegularExecutable,
    private readonly onDiagnostic?: InsertionDiagnosticCallback,
  ) {
    this.pinnedProof = this.proveExecutable(this.executablePath);
  }

  pinExecutableIntegrity(): boolean {
    this.pinnedProof = this.proveExecutable(this.executablePath);
    this.readiness = null;
    return this.pinnedProof !== null;
  }

  async ready(): Promise<boolean> {
    if (!this.executableMatchesPin()) {
      this.readiness = null;
      this.diagnostic("self-test", "integrity_mismatch");
      return false;
    }
    this.readiness ??= this.run("self-test").then((output) => {
      if (output === null) return false;
      try {
        const payload = JSON.parse(output) as {
          platform?: unknown;
          selfTest?: unknown;
        };
        const ready = payload.platform === "darwin" && payload.selfTest === true;
        this.diagnostic("self-test", ready ? undefined : "invalid_response");
        return ready;
      } catch {
        this.diagnostic("self-test", "invalid_response");
        return false;
      }
    });
    const pending = this.readiness;
    const ready = await pending;
    // Keep a successful deterministic self-test, but retry transient execution
    // and protocol failures on the next request with a fresh integrity proof.
    if (!ready && this.readiness === pending) this.readiness = null;
    return ready;
  }

  async captureActiveTarget(): Promise<ActiveTarget | null> {
    const output = await this.run("target");
    if (output === null) return null;
    const target = parseTarget(output);
    if (target === null) this.diagnostic("target", "invalid_response");
    return target;
  }

  async clipboardSequence(): Promise<number | null> {
    const output = await this.run("clipboard-sequence");
    if (output === null) return null;
    let payload: { platform?: unknown; sequence?: unknown };
    try {
      payload = JSON.parse(output) as {
        platform?: unknown;
        sequence?: unknown;
      };
    } catch {
      this.diagnostic("clipboard-sequence", "invalid_response");
      return null;
    }
    if (
      payload === null || typeof payload !== "object" ||
      payload.platform !== "darwin" ||
      !Number.isSafeInteger(payload.sequence) ||
      (payload.sequence as number) < 0
    ) {
      this.diagnostic("clipboard-sequence", "invalid_response");
      return null;
    }
    return payload.sequence as number;
  }

  async paste(
    expectedTarget: ActiveTarget,
    expectedClipboardSequence: number,
  ): Promise<PasteInjectionResult> {
    const arguments_ = pasteArguments(
      expectedTarget,
      expectedClipboardSequence,
    );
    if (arguments_ === null) {
      this.diagnostic("paste", "invalid_request");
      return { status: "failed", reason: "invalid_request" };
    }
    const output = await this.run("paste", arguments_.slice(1));
    if (output === null) return { status: "failed", reason: "helper_unavailable" };
    const result = parsePaste(output);
    if (result.status === "failed") this.diagnostic("paste", result.reason);
    return result;
  }

  async accessibilityReady(): Promise<boolean> {
    return await this.accessibilityStatus() === "granted";
  }

  accessibilityStatus(): Promise<AccessibilityStatus> {
    return this.readAccessibility("accessibility-status");
  }

  async requestAccessibility(): Promise<boolean> {
    return await this.readAccessibility("request-accessibility") === "granted";
  }

  private async readAccessibility(
    command: "accessibility-status" | "request-accessibility",
  ): Promise<AccessibilityStatus> {
    const output = await this.run(command);
    if (output === null) return "unavailable";
    const permissions = parseAccessibilityPermissions(output);
    if (permissions === null) {
      this.diagnostic(command, "invalid_response");
      return "unavailable";
    }
    const state = `${permissions.accessibilityTrusted}:${permissions.postEventsAllowed}`;
    if (state !== this.lastPermissions) {
      this.lastPermissions = state;
      this.diagnostic(command, undefined, permissions);
    }
    return permissions.accessibilityTrusted && permissions.postEventsAllowed ? "granted" : "denied";
  }

  private diagnostic(
    helperCommand: NativeHelperCommand,
    detail?: NativeInsertionDiagnostic["detail"],
    permissions?: Pick<NativeInsertionDiagnostic, "accessibilityTrusted" | "postEventsAllowed">,
  ): void {
    if (detail !== undefined && (
      helperCommand === "accessibility-status" || helperCommand === "request-accessibility"
    )) this.lastPermissions = null;
    if (!this.onDiagnostic) return;
    try {
      // A recorder failure, including an accidentally async callback, is isolated.
      void Promise.resolve(this.onDiagnostic({
        stage: "insertion", event: "native_helper", outcome: detail === undefined ? "ok" : "failed",
        helperCommand, ...(detail === undefined ? {} : { detail }), ...permissions,
      })).catch(() => {});
    } catch {
      // Diagnostics never change the helper result or insertion safety policy.
    }
  }

  private async run(
    command: NativeHelperCommand,
    arguments_: readonly string[] = [],
  ): Promise<string | null> {
    if (!this.executableMatchesPin()) {
      this.diagnostic(command, "integrity_mismatch");
      return null;
    }
    /*
     * Node/macOS cannot exec this verified open descriptor: spawning
     * /dev/fd/<n> is rejected with EACCES, and execFile accepts only a path.
     * executableMatchesPin therefore proves one O_NOFOLLOW descriptor and is
     * deliberately the final synchronous operation before execFile. A hostile
     * same-UID process can still replace the directory entry in that last
     * interval. In packaged builds the pinned bytes include the helper's code
     * signature; that proof, the inode pin, TCC boundary, native target
     * recapture, and clipboard fallback reduce impact. They do not make
     * pathname execution atomic.
     */
    try {
      const { stdout } = await execFileAsync(this.executablePath, [command, ...arguments_], {
        encoding: "utf8",
        env: nativeHelperEnvironment(),
        timeout: helperTimeoutForCommand(command),
        maxBuffer: 16 * 1024,
        shell: false,
        windowsHide: true,
      });
      return stdout.trim();
    } catch (error) {
      this.diagnostic(command, executionFailure(error));
      return null;
    }
  }

  private executableMatchesPin(): boolean {
    const currentProof = this.proveExecutable(this.executablePath);
    return this.pinnedProof !== null
      && currentProof !== null
      && sameExecutableAuthority(this.pinnedProof, currentProof);
  }
}

export class UnavailableInsertionBridge implements PlatformInsertionBridge {
  pinExecutableIntegrity(): false {
    return false;
  }
  async ready(): Promise<false> {
    return false;
  }

  async captureActiveTarget(): Promise<null> {
    return null;
  }

  async clipboardSequence(): Promise<null> {
    return null;
  }
}

export function createDefaultInsertionBridge(
  options: Pick<
    NativeActiveTargetHelperPathOptions,
    "allowEnvironmentOverride" | "workingDirectory"
  > & { onDiagnostic?: InsertionDiagnosticCallback } = {},
): PlatformInsertionBridge {
  const helperPath = resolveNativeActiveTargetHelperPath(options);
  return helperPath
    ? new NativeExecutableInsertionBridge(helperPath, proveRegularExecutable, options.onDiagnostic)
    : new UnavailableInsertionBridge();
}

export const nativeBridgeInternals = {
  digestRegularExecutable,
  proveRegularExecutable,
  sameRegularExecutableProof,
  parseAccessibility,
  parseAccessibilityStatus,
  pasteArguments,
  parsePaste,
  parseTarget,
  helperTimeoutForCommand,
  defaultHelperPath: resolveNativeActiveTargetHelperPath,
};
