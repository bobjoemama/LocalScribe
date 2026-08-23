import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  focusedElementFingerprint: "d".repeat(64),
};

function bridgeWithDigest(
  digest: (executablePath: string) => string | null = () => "a".repeat(64),
): NativeExecutableInsertionBridge {
  return new NativeExecutableInsertionBridge(process.execPath, digest);
}

describe("native platform bridge execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stdout = "";
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runs only a fixed helper command with no shell, bounded output, and no ambient secrets", async () => {
    vi.stubEnv("HF_TOKEN", "must-not-cross-process-boundary");
    vi.stubEnv("HTTPS_PROXY", "http://sensitive-proxy.invalid");
    mocks.stdout = JSON.stringify({
      platform: "darwin",
      processId: 812,
      applicationId: "com.example.Editor",
      windowFingerprint: "c".repeat(64),
      focusedEditable: true,
      focusedElementFingerprint: "d".repeat(64),
    });
    const bridge = bridgeWithDigest();

    await expect(bridge.captureActiveTarget()).resolves.toMatchObject({
      platform: "darwin",
      processId: 812,
      focusedEditable: true,
    });
    const executionOptions = mocks.execFile.mock.calls[0]?.[2];
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
    expect(executionOptions?.env).not.toHaveProperty("HF_TOKEN");
    expect(executionOptions?.env).not.toHaveProperty("HTTPS_PROXY");
    expect(executionOptions?.env).not.toHaveProperty("PATH");
  });

  it("passes only the validated expected target to the native paste command", async () => {
    mocks.stdout = JSON.stringify({ injected: true });
    const bridge = bridgeWithDigest();
    const transcript = "private dictated transcript";

    await expect(bridge.paste(EXPECTED_TARGET, 101)).resolves.toEqual({ status: "injected" });
    expect(mocks.execFile).toHaveBeenCalledWith(
      process.execPath,
      [
        "paste",
        "darwin",
        "812",
        "com.example.Editor",
        "c".repeat(64),
        "d".repeat(64),
        "101",
      ],
      expect.objectContaining({ shell: false }),
      expect.any(Function),
    );
    expect(JSON.stringify(mocks.execFile.mock.calls)).not.toContain(transcript);
  });

  it("accepts zero as a valid macOS clipboard sequence", async () => {
    const bridge = bridgeWithDigest();
    mocks.stdout = JSON.stringify({ platform: "darwin", sequence: 0 });
    await expect(bridge.clipboardSequence()).resolves.toBe(0);
  });

  it("proves helper readiness once with its deterministic self-test", async () => {
    mocks.stdout = JSON.stringify({
      platform: "darwin",
      architecture: "arm64",
      selfTest: true,
    });
    const bridge = bridgeWithDigest();

    await expect(bridge.ready()).resolves.toBe(true);
    await expect(bridge.ready()).resolves.toBe(true);
    expect(mocks.execFile).toHaveBeenCalledOnce();
    expect(mocks.execFile).toHaveBeenCalledWith(
      process.execPath,
      ["self-test"],
      expect.objectContaining({ shell: false, timeout: 1_000 }),
      expect.any(Function),
    );
  });

  it("fails helper readiness closed on malformed self-test output", async () => {
    mocks.stdout = JSON.stringify({ platform: "darwin", selfTest: false });
    const bridge = bridgeWithDigest();

    await expect(bridge.ready()).resolves.toBe(false);
  });

  it("refuses a helper whose bytes change after the verified pin", async () => {
    let digest = "a".repeat(64);
    mocks.stdout = JSON.stringify({
      platform: "darwin",
      selfTest: true,
    });
    const bridge = bridgeWithDigest(() => digest);
    expect(bridge.pinExecutableIntegrity()).toBe(true);
    await expect(bridge.ready()).resolves.toBe(true);

    mocks.execFile.mockClear();
    digest = "b".repeat(64);
    await expect(bridge.captureActiveTarget()).resolves.toBeNull();
    await expect(bridge.ready()).resolves.toBe(false);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("does not spawn the helper for an invalid expected target", async () => {
    const bridge = bridgeWithDigest();

    await expect(bridge.paste({
      ...EXPECTED_TARGET,
      windowFingerprint: null,
    }, 101)).resolves.toEqual({ status: "failed", reason: "invalid_request" });
    await expect(bridge.paste({
      ...EXPECTED_TARGET,
      processId: 0,
    }, 101)).resolves.toEqual({ status: "failed", reason: "invalid_request" });
    await expect(bridge.paste({
      ...EXPECTED_TARGET,
      windowFingerprint: "C".repeat(64),
    }, 101)).resolves.toEqual({ status: "failed", reason: "invalid_request" });
    await expect(bridge.paste({
      ...EXPECTED_TARGET,
      focusedElementFingerprint: null,
    }, 101)).resolves.toEqual({ status: "failed", reason: "invalid_request" });
    await expect(bridge.paste(null as unknown as ActiveTarget, 101)).resolves.toEqual({
      status: "failed",
      reason: "invalid_request",
    });
    await expect(bridge.paste(EXPECTED_TARGET, -1)).resolves.toEqual({
      status: "failed",
      reason: "invalid_request",
    });

    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});
