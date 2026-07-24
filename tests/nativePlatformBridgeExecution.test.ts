import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stdout: "",
  execFile: vi.fn((
    _executable: string,
    _arguments: readonly string[],
    _options: Record<string, unknown>,
    callback: (error: Error | null, result: { stdout: string }) => void,
  ) => callback(null, { stdout: mocks.stdout })),
}));

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));

import { NativeExecutableInsertionBridge } from "../src/main/insertion/nativePlatformBridge";
import type { ActiveTarget } from "../src/main/insertion/types";

const EXPECTED_TARGET: ActiveTarget = {
  platform: "darwin",
  processId: 812,
  applicationId: "com.example.Editor",
  windowFingerprint: "c".repeat(64),
  focusedEditable: true,
};

describe("native platform bridge execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stdout = "";
  });

  it("runs only a fixed helper command with no shell and bounded output", async () => {
    mocks.stdout = JSON.stringify({
      platform: "win32",
      processId: 812,
      applicationId: "C:\\Program Files\\Editor\\editor.exe",
      windowFingerprint: "c".repeat(64),
      focusedEditable: true,
    });
    const bridge = new NativeExecutableInsertionBridge(process.execPath);

    await expect(bridge.captureActiveTarget()).resolves.toMatchObject({
      platform: "win32",
      processId: 812,
      focusedEditable: true,
    });
    expect(mocks.execFile).toHaveBeenCalledWith(
      process.execPath,
      ["target"],
      expect.objectContaining({
        encoding: "utf8",
        maxBuffer: 16 * 1024,
        shell: false,
        timeout: 1_000,
        windowsHide: true,
      }),
      expect.any(Function),
    );
  });

  it("passes only the validated expected target to the native paste command", async () => {
    mocks.stdout = JSON.stringify({ injected: true });
    const bridge = new NativeExecutableInsertionBridge(process.execPath);
    const transcript = "private dictated transcript";

    await expect(bridge.paste(EXPECTED_TARGET)).resolves.toEqual({ status: "injected" });
    expect(mocks.execFile).toHaveBeenCalledWith(
      process.execPath,
      [
        "paste",
        "darwin",
        "812",
        "com.example.Editor",
        "c".repeat(64),
      ],
      expect.objectContaining({ shell: false }),
      expect.any(Function),
    );
    expect(JSON.stringify(mocks.execFile.mock.calls)).not.toContain(transcript);
  });

  it("does not spawn the helper for an invalid expected target", async () => {
    const bridge = new NativeExecutableInsertionBridge(process.execPath);

    await expect(bridge.paste({
      ...EXPECTED_TARGET,
      windowFingerprint: null,
    })).resolves.toEqual({ status: "failed" });
    await expect(bridge.paste({
      ...EXPECTED_TARGET,
      processId: 0,
    })).resolves.toEqual({ status: "failed" });
    await expect(bridge.paste({
      ...EXPECTED_TARGET,
      windowFingerprint: "C".repeat(64),
    })).resolves.toEqual({ status: "failed" });
    await expect(bridge.paste(null as unknown as ActiveTarget)).resolves.toEqual({
      status: "failed",
    });

    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});
