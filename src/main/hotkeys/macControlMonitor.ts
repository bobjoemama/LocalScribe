import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";
import {
  resolveNativeActiveTargetHelperPath,
  type NativeActiveTargetHelperPathOptions,
} from "../nativeHelperPath";

export const CONTROL_MONITOR_EVENTS = [
  "control-down",
  "control-up",
  "space-down",
  "modified-input",
] as const;

export type ControlMonitorEvent = (typeof CONTROL_MONITOR_EVENTS)[number];

const controlMonitorPayloadSchema = z.object({
  event: z.enum(CONTROL_MONITOR_EVENTS),
}).strict();

export interface ControlMonitor {
  start(listener: (event: ControlMonitorEvent) => void): boolean;
  stop(): void;
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

  constructor(private readonly executablePath: string) {}

  start(listener: (event: ControlMonitorEvent) => void): boolean {
    if (this.process) return true;
    if (process.platform !== "darwin" || !existsSync(this.executablePath)) return false;

    const child = spawn(this.executablePath, ["control-monitor"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;
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
      if (message) console.warn(`[control-monitor] ${message.slice(0, 500)}`);
    });
    child.once("error", (error) => {
      console.warn("Permission-free Control monitor could not start", error);
      if (this.process === child) this.process = null;
    });
    child.once("exit", (code, signal) => {
      if (this.process === child) this.process = null;
      if (code && code !== 0) console.warn(`Control monitor exited (${code ?? signal ?? "unknown"})`);
    });
    return true;
  }

  stop(): void {
    const child = this.process;
    this.process = null;
    this.buffer = "";
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
  }
}

export function defaultMacControlMonitorPath(
  options: Pick<NativeActiveTargetHelperPathOptions, "allowEnvironmentOverride"> = {},
): string {
  // Main only instantiates this on macOS, where the resolver always provides
  // the packaged fallback even if the helper is not present yet.
  return resolveNativeActiveTargetHelperPath(options) ?? "";
}
