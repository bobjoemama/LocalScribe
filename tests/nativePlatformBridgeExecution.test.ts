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
    const bridge = new NativeExecutableInsertionBridge("/bin/echo");

    await expect(bridge.captureActiveTarget()).resolves.toMatchObject({
      platform: "win32",
      processId: 812,
      focusedEditable: true,
    });
    expect(mocks.execFile).toHaveBeenCalledWith(
      "/bin/echo",
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

  it("passes no clipboard text or script to the native paste command", async () => {
    mocks.stdout = JSON.stringify({ injected: true });
    const bridge = new NativeExecutableInsertionBridge("/bin/echo");

    await expect(bridge.paste()).resolves.toEqual({ status: "injected" });
    expect(mocks.execFile).toHaveBeenCalledWith(
      "/bin/echo",
      ["paste"],
      expect.objectContaining({ shell: false }),
      expect.any(Function),
    );
  });
});
