import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  resolveNativeActiveTargetHelperPath,
  type NativeActiveTargetHelperPathOptions,
} from "../nativeHelperPath";
import { nativeHelperEnvironment } from "../nativeHelperEnvironment";
import {
  digestRegularExecutable,
  proveRegularExecutable,
  sameRegularExecutableProof,
  type ExecutableProofReader,
  type RegularExecutableProof,
} from "./nativeExecutableIntegrity";
import {
  ACCESSIBILITY_ACTIVATION_OUTCOMES,
  ACCESSIBILITY_ELEMENT_CATEGORIES,
} from "./types";
import type {
  ActiveTarget,
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

function parseAccessibility(raw: string): boolean {
  try {
    const payload = JSON.parse(raw) as HelperAccessibilityPayload;
    return payload.accessibility === true && payload.postEvents === true;
  } catch {
    return false;
  }
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

  constructor(
    private readonly executablePath: string,
    private readonly proveExecutable: ExecutableProofReader = proveRegularExecutable,
  ) {
    this.pinnedProof = this.proveExecutable(this.executablePath);
  }

  pinExecutableIntegrity(): boolean {
    this.pinnedProof = this.proveExecutable(this.executablePath);
    this.readiness = null;
    return this.pinnedProof !== null;
  }

  ready(): Promise<boolean> {
    if (!this.executableMatchesPin()) {
      this.readiness = Promise.resolve(false);
      return this.readiness;
    }
    this.readiness ??= this.run(["self-test"]).then((output) => {
      if (output === null) return false;
      try {
        const payload = JSON.parse(output) as {
          platform?: unknown;
          selfTest?: unknown;
        };
        return payload.platform === "darwin" && payload.selfTest === true;
      } catch {
        return false;
      }
    });
    return this.readiness;
  }

  async captureActiveTarget(): Promise<ActiveTarget | null> {
    const output = await this.run(["target"]);
    return output === null ? null : parseTarget(output);
  }

  async clipboardSequence(): Promise<number | null> {
    const output = await this.run(["clipboard-sequence"]);
    if (output === null) return null;
    let payload: { platform?: unknown; sequence?: unknown };
    try {
      payload = JSON.parse(output) as {
        platform?: unknown;
        sequence?: unknown;
      };
    } catch {
      return null;
    }
    if (
      payload.platform !== "darwin" ||
      !Number.isSafeInteger(payload.sequence) ||
      (payload.sequence as number) < 0
    ) {
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
    if (arguments_ === null) return { status: "failed", reason: "invalid_request" };
    const output = await this.run(arguments_);
    if (output === null) return { status: "failed", reason: "helper_unavailable" };
    return parsePaste(output);
  }

  async accessibilityReady(): Promise<boolean> {
    return this.readAccessibility("accessibility-status");
  }

  async requestAccessibility(): Promise<boolean> {
    return this.readAccessibility("request-accessibility");
  }

  private async readAccessibility(
    command: "accessibility-status" | "request-accessibility",
  ): Promise<boolean> {
    const output = await this.run([command]);
    if (output === null) return false;
    return parseAccessibility(output);
  }

  private async run(
    arguments_: readonly string[],
  ): Promise<string | null> {
    if (!this.executableMatchesPin()) {
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
      const { stdout } = await execFileAsync(this.executablePath, arguments_, {
        encoding: "utf8",
        env: nativeHelperEnvironment(),
        timeout: helperTimeoutForCommand(arguments_[0]),
        maxBuffer: 16 * 1024,
        shell: false,
        windowsHide: true,
      });
      return stdout.trim();
    } catch {
      return null;
    }
  }

  private executableMatchesPin(): boolean {
    const currentProof = this.proveExecutable(this.executablePath);
    return this.pinnedProof !== null
      && currentProof !== null
      && sameRegularExecutableProof(this.pinnedProof, currentProof);
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
  > = {},
): PlatformInsertionBridge {
  const helperPath = resolveNativeActiveTargetHelperPath(options);
  return helperPath
    ? new NativeExecutableInsertionBridge(helperPath)
    : new UnavailableInsertionBridge();
}

export const nativeBridgeInternals = {
  digestRegularExecutable,
  proveRegularExecutable,
  sameRegularExecutableProof,
  parseAccessibility,
  pasteArguments,
  parsePaste,
  parseTarget,
  helperTimeoutForCommand,
  defaultHelperPath: resolveNativeActiveTargetHelperPath,
};
