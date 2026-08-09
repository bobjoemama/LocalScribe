import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";
import { shortcutTokens, type HoldShortcut } from "../../shared/shortcuts";
import {
  resolveNativeActiveTargetHelperPath,
  type NativeActiveTargetHelperPathOptions,
} from "../nativeHelperPath";
import { nativeHelperEnvironment } from "../nativeHelperEnvironment";

export const CONTROL_MONITOR_EVENTS = [
  "hold-down",
  "hold-up",
  "modified-input",
] as const;

export type ControlMonitorEvent = (typeof CONTROL_MONITOR_EVENTS)[number];

const controlMonitorPayloadSchema = z.object({
  event: z.enum(CONTROL_MONITOR_EVENTS),
}).strict();

export interface ControlMonitor {
  supports(shortcut: HoldShortcut): boolean;
  start(
    shortcut: HoldShortcut,
    listener: (event: ControlMonitorEvent) => void,
    onStopped?: () => void,
  ): boolean;
  stop(): void;
}

/*
 * Carbon does not define physical virtual-key codes for these PC-only or
 * post-F20 keys. Preserve the uiohook path for them instead of claiming the
 * permission-free monitor can observe a key that macOS does not identify.
 */
const UNSUPPORTED_NATIVE_MAC_TOKENS = new Set([
  "ScrollLock",
  "PrintScreen",
  "F21",
  "F22",
  "F23",
  "F24",
]);

export function nativeMacHoldMonitorSupports(shortcut: HoldShortcut): boolean {
  try {
    return shortcutTokens(shortcut).every((token) => !UNSUPPORTED_NATIVE_MAC_TOKENS.has(token));
  } catch {
    return false;
  }
}

export function parseControlMonitorLine(line: string): ControlMonitorEvent | null {
  try {
    const parsed = controlMonitorPayloadSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data.event : null;
  } catch {
    return null;
  }
}

export class MacControlMonitor implements ControlMonitor {
  private process: ChildProcess | null = null;
  private buffer = "";
  private onStopped: (() => void) | null = null;

  constructor(
    private readonly executablePath: string,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  supports(shortcut: HoldShortcut): boolean {
    return this.platform === "darwin" && nativeMacHoldMonitorSupports(shortcut);
  }

  start(
    shortcut: HoldShortcut,
    listener: (event: ControlMonitorEvent) => void,
    onStopped?: () => void,
  ): boolean {
    if (this.process) return true;
    if (!this.supports(shortcut) || !existsSync(this.executablePath)) return false;

    const child = spawn(this.executablePath, ["hold-monitor", shortcut], {
      env: nativeHelperEnvironment(this.platform),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;
    this.onStopped = onStopped ?? null;
    this.buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 16 * 1024) this.buffer = this.buffer.slice(-16 * 1024);
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseControlMonitorLine(line);
        if (event) listener(event);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const message = chunk.trim();
      if (message) console.warn(`[hold-monitor] ${message.slice(0, 500)}`);
    });
    child.once("error", (error) => {
      console.warn("Permission-free hold monitor could not start", error);
      this.handleStopped(child);
    });
    child.once("exit", (code, signal) => {
      this.handleStopped(child);
      if (code && code !== 0) console.warn(`Hold monitor exited (${code ?? signal ?? "unknown"})`);
    });
    return true;
  }

  stop(): void {
    const child = this.process;
    this.process = null;
    this.buffer = "";
    this.onStopped = null;
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
  }

  private handleStopped(child: ChildProcess): void {
    if (this.process !== child) return;
    this.process = null;
    this.buffer = "";
    const onStopped = this.onStopped;
    this.onStopped = null;
    onStopped?.();
  }
}

export function defaultMacControlMonitorPath(
  options: Pick<
    NativeActiveTargetHelperPathOptions,
    "allowEnvironmentOverride" | "workingDirectory"
  > = {},
): string {
  // Main only instantiates this on macOS, where the resolver always provides
  // the packaged fallback even if the helper is not present yet.
  return resolveNativeActiveTargetHelperPath(options) ?? "";
}
