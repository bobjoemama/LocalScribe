import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  stdout: "",
  delayMs: 0,
  execFile: vi.fn((
    _executable: string,
    _arguments: readonly string[],
    _options: Record<string, unknown>,
    callback: (error: Error | null, result: { stdout: string }) => void,
  ) => {
    const complete = () => callback(null, { stdout: mocks.stdout });
    if (mocks.delayMs > 0) setTimeout(complete, mocks.delayMs);
    else complete();
  }),
}));

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));

import {
  NativeExecutableInsertionBridge,
  nativeBridgeInternals,
} from "../src/main/insertion/nativePlatformBridge";
import type { ActiveTarget } from "../src/main/insertion/types";
import type { RegularExecutableProof } from "../src/main/insertion/nativeExecutableIntegrity";

const EXPECTED_TARGET: ActiveTarget = {
  platform: "darwin",
  processId: 812,
  applicationId: "com.example.Editor",
  windowFingerprint: "c".repeat(64),
  focusedEditable: true,
  focusedElementFingerprint: "d".repeat(64),
};

function proofForDigest(digest: string): RegularExecutableProof {
  return {
    sha256: digest,
    device: 1,
    inode: 2,
    mode: 0o100700,
    size: 100,
    modifiedAtMs: 3,
    changedAtMs: 4,
  };
}

function bridgeWithDigest(
  digest: (executablePath: string) => string | null = () => "a".repeat(64),
): NativeExecutableInsertionBridge {
  return new NativeExecutableInsertionBridge(process.execPath, (executablePath) => {
    const value = digest(executablePath);
    return value === null ? null : proofForDigest(value);
  });
}

describe("native platform bridge execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stdout = "";
    mocks.delayMs = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pins only stable regular executable bytes and rejects a symlink", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "localscribe-native-digest-"));
    try {
      const executable = path.join(directory, "helper");
      const linkedExecutable = path.join(directory, "linked-helper");
      const bytes = Buffer.from("fixed helper bytes");
      writeFileSync(executable, bytes, { mode: 0o700 });
      symlinkSync(executable, linkedExecutable);

      expect(nativeBridgeInternals.digestRegularExecutable(executable)).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(nativeBridgeInternals.digestRegularExecutable(linkedExecutable)).toBeNull();
      expect(nativeBridgeInternals.digestRegularExecutable(directory)).toBeNull();

      const originalProof = nativeBridgeInternals.proveRegularExecutable(executable);
      const replacement = path.join(directory, "replacement-helper");
      writeFileSync(replacement, bytes, { mode: 0o700 });
      renameSync(replacement, executable);
      const replacementProof = nativeBridgeInternals.proveRegularExecutable(executable);
      expect(originalProof?.sha256).toBe(replacementProof?.sha256);
      expect(
        originalProof && replacementProof
          ? nativeBridgeInternals.sameRegularExecutableProof(originalProof, replacementProof)
          : true,
      ).toBe(false);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it("refuses an exact-byte helper replacement because its pinned file identity changed", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "localscribe-native-replace-"));
    try {
      const executable = path.join(directory, "helper");
      const replacement = path.join(directory, "replacement-helper");
      const bytes = Buffer.from("same signed helper bytes");
      writeFileSync(executable, bytes, { mode: 0o700 });
      const bridge = new NativeExecutableInsertionBridge(executable);
      writeFileSync(replacement, bytes, { mode: 0o700 });
      renameSync(replacement, executable);

      await expect(bridge.captureActiveTarget()).resolves.toBeNull();
      expect(mocks.execFile).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it("documents the residual pathname-exec race instead of claiming descriptor atomicity", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) => readFile(
      path.resolve("src/main/insertion/nativePlatformBridge.ts"),
      "utf8",
    ));

    expect(source).toContain("O_NOFOLLOW descriptor");
    expect(source).toContain("/dev/fd/<n> is rejected with EACCES");
    expect(source).toContain("do not make");
    expect(source).toContain("pathname execution atomic");
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
        timeout: 3_500,
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
      expect.objectContaining({ shell: false, timeout: 6_000 }),
      expect.any(Function),
    );
    expect(JSON.stringify(mocks.execFile.mock.calls)).not.toContain(transcript);
  });

  it("allows a delayed cold-target helper beyond the one-second baseline", async () => {
    vi.useFakeTimers();
    try {
      mocks.delayMs = 2_100;
      mocks.stdout = JSON.stringify({
        platform: "darwin",
        processId: 812,
        applicationId: "com.example.Editor",
        windowFingerprint: "c".repeat(64),
        focusedEditable: true,
        focusedElementFingerprint: "d".repeat(64),
      });
      const bridge = bridgeWithDigest();

      const pendingTarget = bridge.captureActiveTarget();
      await vi.advanceTimersByTimeAsync(2_100);

      await expect(pendingTarget).resolves.toMatchObject({ processId: 812 });
      expect(mocks.execFile).toHaveBeenCalledWith(
        process.execPath,
        ["target"],
        expect.objectContaining({ timeout: 3_500 }),
        expect.any(Function),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives paste enough time for two delayed captures while other commands stay bounded", async () => {
    vi.useFakeTimers();
    try {
      mocks.delayMs = 4_100;
      mocks.stdout = JSON.stringify({ injected: true });
      const bridge = bridgeWithDigest();

      const pendingPaste = bridge.paste(EXPECTED_TARGET, 101);
      await vi.advanceTimersByTimeAsync(4_100);

      await expect(pendingPaste).resolves.toEqual({ status: "injected" });
      expect(mocks.execFile.mock.calls[0]?.[2]).toMatchObject({ timeout: 6_000 });
      expect(nativeBridgeInternals.helperTimeoutForCommand("self-test")).toBe(1_000);
      expect(nativeBridgeInternals.helperTimeoutForCommand("clipboard-sequence")).toBe(1_000);
      expect(nativeBridgeInternals.helperTimeoutForCommand("accessibility-status")).toBe(1_000);
      expect(nativeBridgeInternals.helperTimeoutForCommand("hold-monitor")).toBe(1_000);
      expect(nativeBridgeInternals.helperTimeoutForCommand("request-accessibility")).toBe(15_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts zero as a valid macOS clipboard sequence", async () => {
    const bridge = bridgeWithDigest();
    mocks.stdout = JSON.stringify({ platform: "darwin", sequence: 0 });
    await expect(bridge.clipboardSequence()).resolves.toBe(0);
  });

  it("uses one second for short commands and fifteen seconds for the permission prompt", async () => {
    const bridge = bridgeWithDigest();
    mocks.stdout = JSON.stringify({ platform: "darwin", sequence: 7 });
    await expect(bridge.clipboardSequence()).resolves.toBe(7);
    expect(mocks.execFile.mock.calls[0]?.[2]).toMatchObject({ timeout: 1_000 });

    mocks.stdout = JSON.stringify({ accessibility: true, postEvents: true });
    await expect(bridge.accessibilityReady()).resolves.toBe(true);
    expect(mocks.execFile.mock.calls[1]?.[2]).toMatchObject({ timeout: 1_000 });

    await expect(bridge.requestAccessibility()).resolves.toBe(true);
    expect(mocks.execFile.mock.calls[2]?.[2]).toMatchObject({ timeout: 15_000 });
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
