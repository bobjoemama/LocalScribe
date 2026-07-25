import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
} from "node:fs";
import { promisify } from "node:util";
import {
  resolveNativeActiveTargetHelperPath,
  type NativeActiveTargetHelperPathOptions,
} from "../nativeHelperPath";
import { nativeHelperEnvironment } from "../nativeHelperEnvironment";
import type { ActiveTarget, PasteInjectionResult, PlatformInsertionBridge } from "./types";

const execFileAsync = promisify(execFile);
type ExecutableDigest = (executablePath: string) => string | null;

function digestRegularExecutable(executablePath: string): string | null {
  try {
    const before = lstatSync(executablePath);
    if (!before.isFile() || before.isSymbolicLink()) return null;
    const bytes = readFileSync(executablePath);
    const after = lstatSync(executablePath);
    if (
      !after.isFile()
      || after.isSymbolicLink()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || bytes.byteLength !== before.size
    ) {
      return null;
    }
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return null;
  }
}

interface HelperTargetPayload {
  platform?: unknown;
  processId?: unknown;
  applicationId?: unknown;
  windowFingerprint?: unknown;
  focusedEditable?: unknown;
  focusedElementFingerprint?: unknown;
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
      payload.platform === "darwin" &&
      payload.focusedElementFingerprint !== null &&
      typeof payload.focusedElementFingerprint !== "string"
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
  const focusedElementFingerprint = payload.platform === "darwin"
    ? payload.focusedElementFingerprint as string | null
    : undefined;
  if (
    focusedElementFingerprint !== undefined &&
    focusedElementFingerprint !== null &&
    !/^[a-f0-9]{64}$/i.test(focusedElementFingerprint)
  ) {
    return null;
  }

  const target: ActiveTarget = {
    platform: payload.platform,
    processId: payload.processId as number,
    applicationId: payload.applicationId,
    windowFingerprint,
  };
  target.focusedEditable = payload.focusedEditable as boolean | null;
  if (payload.platform === "darwin") {
    target.focusedElementFingerprint = focusedElementFingerprint;
  }
  return target;
}

function pasteArguments(
  target: ActiveTarget,
  expectedClipboardSequence: number,
): string[] | null {
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
    !/^[a-f0-9]{64}$/.test(target.windowFingerprint) ||
    !Number.isSafeInteger(expectedClipboardSequence) ||
    expectedClipboardSequence < (target.platform === "win32" ? 1 : 0) ||
    (
      target.platform === "win32" &&
      expectedClipboardSequence > 4_294_967_295
    )
  ) {
    return null;
  }
  if (
    target.platform === "darwin"
    && (
      typeof target.focusedElementFingerprint !== "string"
      || !/^[a-f0-9]{64}$/.test(target.focusedElementFingerprint)
    )
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
  if (target.platform === "darwin") arguments_.push(target.focusedElementFingerprint!);
  arguments_.push(String(expectedClipboardSequence));
  return arguments_;
}

export class NativeExecutableInsertionBridge implements PlatformInsertionBridge {
  private readiness: Promise<boolean> | null = null;
  private pinnedDigest: string | null;

  constructor(
    private readonly executablePath: string,
    private readonly digestExecutable: ExecutableDigest = digestRegularExecutable,
  ) {
    this.pinnedDigest = this.digestExecutable(this.executablePath);
  }

  pinExecutableIntegrity(): boolean {
    this.pinnedDigest = this.digestExecutable(this.executablePath);
    this.readiness = null;
    return this.pinnedDigest !== null;
  }

  ready(): Promise<boolean> {
    if (
      this.pinnedDigest === null
      || this.digestExecutable(this.executablePath) !== this.pinnedDigest
    ) {
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
        return (
          (payload.platform === "darwin" || payload.platform === "win32")
          && payload.selfTest === true
        );
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
      (payload.platform !== "darwin" && payload.platform !== "win32") ||
      !Number.isSafeInteger(payload.sequence) ||
      (payload.sequence as number) < (payload.platform === "win32" ? 1 : 0)
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
    if (
      !existsSync(this.executablePath)
      || this.pinnedDigest === null
      || this.digestExecutable(this.executablePath) !== this.pinnedDigest
    ) {
      return null;
    }
    try {
      const { stdout } = await execFileAsync(this.executablePath, arguments_, {
        encoding: "utf8",
        env: nativeHelperEnvironment(),
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
  parseAccessibility,
  pasteArguments,
  parsePaste,
  parseTarget,
  defaultHelperPath: resolveNativeActiveTargetHelperPath,
};
