import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import {
  MacControlMonitor,
  nativeMacHoldMonitorSupports,
  parseControlMonitorLine,
} from "../src/main/hotkeys/macControlMonitor";
import { resolveNativeActiveTargetHelperPath } from "../src/main/nativeHelperPath";

class FakeMonitorProcess extends EventEmitter {
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  readonly stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn(() => true);
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("macOS hold monitor protocol", () => {
  it("accepts only the three non-content key-state events", () => {
    expect(parseControlMonitorLine('{"event":"hold-down"}')).toBe("hold-down");
    expect(parseControlMonitorLine('{"event":"hold-up"}')).toBe("hold-up");
    expect(parseControlMonitorLine('{"event":"modified-input"}')).toBe("modified-input");
  });

  it("rejects malformed, extra, and content-bearing payloads", () => {
    expect(parseControlMonitorLine("not json")).toBeNull();
    expect(parseControlMonitorLine('{"event":"key-down","key":"A"}')).toBeNull();
    expect(parseControlMonitorLine('{"event":"hold-down","key":"Control"}')).toBeNull();
  });

  it("routes common Mac chords through the narrow helper and preserves rare-key fallback", () => {
    expect(nativeMacHoldMonitorSupports("Command+Control")).toBe(true);
    expect(nativeMacHoldMonitorSupports("Alt+Space")).toBe(true);
    expect(nativeMacHoldMonitorSupports("F20")).toBe(true);
    expect(nativeMacHoldMonitorSupports("F21")).toBe(false);
    expect(nativeMacHoldMonitorSupports("PrintScreen")).toBe(false);
  });

  it("passes no ambient secrets and reports asynchronous helper death once", () => {
    vi.stubEnv("HF_TOKEN", "must-not-cross-process-boundary");
    vi.stubEnv("HTTPS_PROXY", "http://sensitive-proxy.invalid");
    const first = new FakeMonitorProcess();
    const second = new FakeMonitorProcess();
    vi.mocked(spawn)
      .mockReturnValueOnce(first as never)
      .mockReturnValueOnce(second as never);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stopped = vi.fn();
    const monitor = new MacControlMonitor(process.execPath);

    expect(monitor.start("Command+Control", vi.fn(), stopped)).toBe(true);
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(["hold-monitor", "Command+Control"]);
    const options = vi.mocked(spawn).mock.calls[0]?.[2];
    expect(options).toMatchObject({
      env: {},
      shell: false,
    });
    expect(options?.env).not.toHaveProperty("HF_TOKEN");
    expect(options?.env).not.toHaveProperty("HTTPS_PROXY");
    expect(options?.env).not.toHaveProperty("PATH");

    first.emit("error", new Error("EACCES"));
    first.emit("exit", 1, null);
    expect(stopped).toHaveBeenCalledOnce();

    expect(monitor.start("Alt+Space", vi.fn(), stopped)).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });
});

describe("native active-target helper resolution", () => {
  it("uses the explicit development override for both insertion and hold monitoring", () => {
    const override = path.resolve("test-fixtures", "test-helper");
    expect(resolveNativeActiveTargetHelperPath({
      platform: "darwin",
      environment: { LOCALSCRIBE_NATIVE_INSERTION_HELPER: override },
      allowEnvironmentOverride: true,
    })).toBe(override);
  });

  it("anchors a relative development override to the application root rather than shell cwd", () => {
    const workingDirectory = path.resolve("test-fixtures", "workspace");
    expect(resolveNativeActiveTargetHelperPath({
      platform: "darwin",
      environment: { LOCALSCRIBE_NATIVE_INSERTION_HELPER: "build/active-target" },
      allowEnvironmentOverride: true,
      workingDirectory,
    })).toBe(path.join(workingDirectory, "build", "active-target"));
  });

  it("never accepts an environment helper override for a packaged caller", () => {
    const resourcesPath = path.resolve("test-fixtures", "bundle", "resources");
    const workingDirectory = path.resolve("test-fixtures", "workspace");
    const packaged = path.join(resourcesPath, "native", "macos", "active-target");
    expect(resolveNativeActiveTargetHelperPath({
      platform: "darwin",
      environment: {
        LOCALSCRIBE_NATIVE_INSERTION_HELPER: path.resolve("test-fixtures", "untrusted-helper"),
      },
      allowEnvironmentOverride: false,
      resourcesPath,
      workingDirectory,
      exists: (candidate) => candidate === packaged,
    })).toBe(packaged);
  });

  it("prefers the signed packaged helper before the source-tree copy", () => {
    const resourcesPath = path.resolve("test-fixtures", "bundle", "resources");
    const workingDirectory = path.resolve("test-fixtures", "workspace");
    const packaged = path.join(resourcesPath, "native", "macos", "active-target");
    expect(resolveNativeActiveTargetHelperPath({
      platform: "darwin",
      environment: {},
      resourcesPath,
      workingDirectory,
      exists: (candidate) => candidate === packaged,
    })).toBe(packaged);
  });

  it("uses the development helper only when no packaged helper exists", () => {
    const resourcesPath = path.resolve("test-fixtures", "bundle", "resources");
    const workingDirectory = path.resolve("test-fixtures", "workspace");
    const development = path.join(
      workingDirectory,
      "resources",
      "native",
      "macos",
      "active-target",
    );
    expect(resolveNativeActiveTargetHelperPath({
      platform: "darwin",
      environment: {},
      resourcesPath,
      workingDirectory,
      exists: (candidate) => candidate === development,
    })).toBe(development);
  });
});
