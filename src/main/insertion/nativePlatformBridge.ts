import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import {
  resolveNativeActiveTargetHelperPath,
  type NativeActiveTargetHelperPathOptions,
} from "../nativeHelperPath";
import type { ActiveTarget, PasteInjectionResult, PlatformInsertionBridge } from "./types";

const execFileAsync = promisify(execFile);

interface HelperTargetPayload {
  platform?: unknown;
  processId?: unknown;
  applicationId?: unknown;
  windowFingerprint?: unknown;
  focusedEditable?: unknown;
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
    const payload = JSON.parse(raw) as { injected?: unknown };
    return payload.injected === true ? { status: "injected" } : { status: "failed" };
  } catch {
    return { status: "failed" };
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
    (payload.platform !== "darwin" && payload.platform !== "win32") ||
    !Number.isSafeInteger(payload.processId) ||
    (payload.processId as number) <= 0 ||
    typeof payload.applicationId !== "string" ||
    payload.applicationId.length === 0 ||
    payload.applicationId.length > 1_024 ||
    (payload.windowFingerprint !== null && typeof payload.windowFingerprint !== "string") ||
    (
      payload.platform === "darwin" &&
      payload.focusedEditable !== null &&
      typeof payload.focusedEditable !== "boolean"
    ) ||
    (
      payload.platform === "win32" &&
      typeof payload.focusedEditable !== "boolean"
    )
  ) {
    return null;
  }

  const windowFingerprint = payload.windowFingerprint as string | null;
  if (windowFingerprint !== null && !/^[a-f0-9]{64}$/i.test(windowFingerprint)) return null;

  const target: ActiveTarget = {
    platform: payload.platform,
    processId: payload.processId as number,
    applicationId: payload.applicationId,
    windowFingerprint,
  };
  target.focusedEditable = payload.focusedEditable as boolean | null;
  return target;
}

function pasteArguments(target: ActiveTarget): string[] | null {
  if (!target || typeof target !== "object") return null;
  const maximumProcessId = target.platform === "darwin"
    ? 2_147_483_647
    : target.platform === "win32"
      ? 4_294_967_295
      : 0;
  if (
    maximumProcessId === 0 ||
    !Number.isSafeInteger(target.processId) ||
    target.processId <= 0 ||
    target.processId > maximumProcessId ||
    typeof target.applicationId !== "string" ||
    target.applicationId.length === 0 ||
    Buffer.byteLength(target.applicationId, "utf8") > 1_024 ||
    target.applicationId.includes("\0") ||
    typeof target.windowFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(target.windowFingerprint)
  ) {
    return null;
  }

  return [
    "paste",
    target.platform,
    String(target.processId),
    target.applicationId,
    target.windowFingerprint,
  ];
}

export class NativeExecutableInsertionBridge implements PlatformInsertionBridge {
  constructor(private readonly executablePath: string) {}

  async captureActiveTarget(): Promise<ActiveTarget | null> {
    const output = await this.run(["target"]);
    return output === null ? null : parseTarget(output);
  }

  async clipboardSequence(): Promise<number | null> {
    const output = await this.run(["clipboard-sequence"]);
    if (output === null) return null;
    let payload: { sequence?: unknown };
    try {
      payload = JSON.parse(output) as { sequence?: unknown };
    } catch {
      return null;
    }
    return Number.isSafeInteger(payload.sequence) && (payload.sequence as number) >= 0
      ? (payload.sequence as number)
      : null;
  }

  async paste(expectedTarget: ActiveTarget): Promise<PasteInjectionResult> {
    const arguments_ = pasteArguments(expectedTarget);
    if (arguments_ === null) return { status: "failed" };
    const output = await this.run(arguments_);
    if (output === null) return { status: "failed" };
    return parsePaste(output);
  }

  async accessibilityReady(): Promise<boolean> {
    return this.readAccessibility("accessibility-status");
  }

  async requestAccessibility(): Promise<boolean> {
    return this.readAccessibility("request-accessibility", 15_000);
  }

  private async readAccessibility(
    command: "accessibility-status" | "request-accessibility",
    timeout = 1_000,
  ): Promise<boolean> {
    const output = await this.run([command], timeout);
    if (output === null) return false;
    return parseAccessibility(output);
  }

  private async run(
    arguments_: readonly string[],
    timeout = 1_000,
  ): Promise<string | null> {
    if (!existsSync(this.executablePath)) return null;
    try {
      const { stdout } = await execFileAsync(this.executablePath, arguments_, {
        encoding: "utf8",
        timeout,
        maxBuffer: 16 * 1024,
        shell: false,
        windowsHide: true,
      });
      return stdout.trim();
    } catch {
      return null;
    }
  }
}

export class UnavailableInsertionBridge implements PlatformInsertionBridge {
  async captureActiveTarget(): Promise<null> {
    return null;
  }

  async clipboardSequence(): Promise<null> {
    return null;
  }
}

export function createDefaultInsertionBridge(
  options: Pick<NativeActiveTargetHelperPathOptions, "allowEnvironmentOverride"> = {},
): PlatformInsertionBridge {
  const helperPath = resolveNativeActiveTargetHelperPath(options);
  return helperPath
    ? new NativeExecutableInsertionBridge(helperPath)
    : new UnavailableInsertionBridge();
}

export const nativeBridgeInternals = {
  parseAccessibility,
  pasteArguments,
  parsePaste,
  parseTarget,
  defaultHelperPath: resolveNativeActiveTargetHelperPath,
};
