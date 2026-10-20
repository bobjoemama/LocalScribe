import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveTarget, NativeInsertionDiagnostic } from "../src/main/insertion/types";
import { assertRedacted, formatDiagnosticLine } from "../src/shared/diagnosticsLog";

const mocks = vi.hoisted(() => ({
  stdout: "",
  error: null as unknown,
  execFile: vi.fn((
    _file: string, _args: readonly string[], _options: unknown,
    callback: (error: unknown, result: { stdout: string }) => void,
  ) => callback(mocks.error, { stdout: mocks.stdout })),
}));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("electron", () => ({ clipboard: {}, nativeImage: {} }));
vi.mock("../src/main/nativeHelperPath", () => ({
  resolveNativeActiveTargetHelperPath: () => "/synthetic/private/helper",
}));

import { NativeExecutableInsertionBridge } from "../src/main/insertion/nativePlatformBridge";
import { InsertionService } from "../src/main/insertion/insertionService";

const TARGET: ActiveTarget = {
  platform: "darwin", processId: 812, applicationId: "com.example.private",
  windowFingerprint: "c".repeat(64), focusedEditable: true,
  focusedElementFingerprint: "d".repeat(64),
};
const PROOF = {
  sha256: "a".repeat(64), device: 1, inode: 2, mode: 0o100700,
  ownerId: 501, groupId: 20, size: 100, modifiedAtMs: 3, changedAtMs: 4,
};
function fixture() {
  const events: NativeInsertionDiagnostic[] = [];
  const bridge = new NativeExecutableInsertionBridge(
    "/synthetic/private/helper", () => PROOF, (event) => { events.push(event); },
  );
  return { bridge, events };
}

beforeEach(() => {
  mocks.stdout = "";
  mocks.error = null;
  vi.clearAllMocks();
});

describe("content-free helper failure diagnostics", () => {
  it.each([
    [{ killed: true, signal: "SIGTERM", code: null }, "timeout"],
    [{ code: "ETIMEDOUT" }, "timeout"],
    [{ code: "ENOENT" }, "spawn_failure"],
    [{ code: "EACCES" }, "spawn_failure"],
    [{ code: 1, killed: false }, "exit_failure"],
    [{ code: null, signal: "SIGABRT" }, "exit_failure"],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "invalid_response"],
  ])("preserves a safe category when execution returns null: %j", async (fields, detail) => {
    const { bridge, events } = fixture();
    mocks.error = Object.assign(new Error("/Users/private/transcript"), fields, {
      stdout: "private output", stderr: "private error", path: "/private/helper",
    });
    await expect(bridge.captureActiveTarget()).resolves.toBeNull();
    expect(events).toEqual([{
      stage: "insertion", event: "native_helper", outcome: "failed",
      helperCommand: "target", detail,
    }]);
    const line = formatDiagnosticLine({ ...events[0]!, at: 1 });
    expect(JSON.parse(line)).toEqual({ ...events[0], at: 1 });
    expect(() => assertRedacted(line)).not.toThrow();
    expect(line).not.toMatch(/private|ENOENT|EACCES|SIG|stdout|stderr|path/u);
  });

  it("does not inspect hostile getters, coerce error values, or propagate proxy traps", async () => {
    const { bridge, events } = fixture();
    const getter = vi.fn(() => { throw new Error("private message"); });
    const hostile = Object.defineProperties({}, {
      code: { get: getter }, killed: { get: getter }, signal: { get: getter },
      message: { get: getter }, stdout: { get: getter }, stderr: { get: getter },
      toString: { value: getter },
    });
    for (const error of [hostile, new Proxy({}, { getOwnPropertyDescriptor: getter }), {
      code: { toString: getter }, signal: { toString: getter },
    }]) {
      mocks.error = error;
      await expect(bridge.accessibilityStatus()).resolves.toBe("unavailable");
    }
    expect(events.map(({ detail }) => detail)).toEqual([
      "spawn_failure", "spawn_failure", "spawn_failure",
    ]);
    // Only the deliberately throwing descriptor proxy is touched.
    expect(getter).toHaveBeenCalledOnce();
  });

  it.each(["not json", "null", "{}", "[]", '"private"'])(
    "classifies malformed output for every helper boundary: %s", async (stdout) => {
      const { bridge, events } = fixture();
      mocks.stdout = stdout;
      await expect(bridge.ready()).resolves.toBe(false);
      await expect(bridge.captureActiveTarget()).resolves.toBeNull();
      await expect(bridge.clipboardSequence()).resolves.toBeNull();
      await expect(bridge.accessibilityStatus()).resolves.toBe("unavailable");
      await expect(bridge.requestAccessibility()).resolves.toBe(false);
      await expect(bridge.paste(TARGET, 3)).resolves.toEqual({
        status: "failed", reason: "invalid_response",
      });
      expect(events.map(({ helperCommand, detail }) => [helperCommand, detail])).toEqual([
        ["self-test", "invalid_response"], ["target", "invalid_response"],
        ["clipboard-sequence", "invalid_response"],
        ["accessibility-status", "invalid_response"],
        ["request-accessibility", "invalid_response"], ["paste", "invalid_response"],
      ]);
    },
  );

  it("reports integrity refusal before spawn without exposing helper identity", async () => {
    const events: NativeInsertionDiagnostic[] = [];
    let proof = PROOF;
    const bridge = new NativeExecutableInsertionBridge(
      "/private/helper", () => proof, (event) => { events.push(event); },
    );
    proof = { ...PROOF, inode: 99 };
    await expect(bridge.ready()).resolves.toBe(false);
    await expect(bridge.paste(TARGET, 3)).resolves.toEqual({
      status: "failed", reason: "helper_unavailable",
    });
    expect(events).toEqual(["self-test", "paste"].map((helperCommand) => ({
      stage: "insertion", event: "native_helper", outcome: "failed",
      helperCommand, detail: "integrity_mismatch",
    })));
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("retains valid permission booleans, distinguishes unavailable, and suppresses unchanged polls", async () => {
    const { bridge, events } = fixture();
    for (const [accessibility, postEvents, status] of [
      [true, false, "denied"], [false, true, "denied"],
      [false, false, "denied"], [true, true, "granted"],
    ] as const) {
      mocks.stdout = JSON.stringify({ accessibility, postEvents });
      await expect(bridge.accessibilityStatus()).resolves.toBe(status);
      await expect(bridge.accessibilityStatus()).resolves.toBe(status);
    }
    expect(events).toEqual([[true, false], [false, true], [false, false], [true, true]].map(
      ([accessibilityTrusted, postEventsAllowed]) => ({
        stage: "insertion", event: "native_helper", outcome: "ok",
        helperCommand: "accessibility-status", accessibilityTrusted, postEventsAllowed,
      }),
    ));
    mocks.error = { code: "ENOENT" };
    await expect(bridge.accessibilityStatus()).resolves.toBe("unavailable");
    expect(events.at(-1)).not.toHaveProperty("accessibilityTrusted");
    mocks.error = null;
    await expect(bridge.accessibilityStatus()).resolves.toBe("granted");
    expect(events).toHaveLength(6);
  });

  it("emits self-test once and no success records for target, clipboard, or paste", async () => {
    const { bridge, events } = fixture();
    mocks.stdout = '{"platform":"darwin","selfTest":true}';
    await expect(bridge.ready()).resolves.toBe(true);
    await expect(bridge.ready()).resolves.toBe(true);
    for (let i = 0; i < 2; i += 1) {
      mocks.stdout = JSON.stringify(TARGET);
      await expect(bridge.captureActiveTarget()).resolves.toEqual(TARGET);
      mocks.stdout = '{"platform":"darwin","sequence":3}';
      await expect(bridge.clipboardSequence()).resolves.toBe(3);
      mocks.stdout = '{"injected":true}';
      await expect(bridge.paste(TARGET, 3)).resolves.toEqual({ status: "injected" });
    }
    expect(events).toEqual([{
      stage: "insertion", event: "native_helper", outcome: "ok", helperCommand: "self-test",
    }]);
  });

  it("retains native paste rejection and invalid-request safety without emitting target data", async () => {
    const { bridge, events } = fixture();
    mocks.stdout = '{"injected":false,"reason":"clipboard_changed"}';
    await expect(bridge.paste(TARGET, 3)).resolves.toEqual({
      status: "failed", reason: "clipboard_changed",
    });
    await expect(bridge.paste({ ...TARGET, focusedElementFingerprint: null }, 3)).resolves.toEqual({
      status: "failed", reason: "invalid_request",
    });
    expect(events.map(({ detail }) => detail)).toEqual(["clipboard_changed", "invalid_request"]);
    expect(mocks.execFile).toHaveBeenCalledOnce();
    expect(JSON.stringify(events)).not.toContain(TARGET.applicationId);
  });

  it("isolates a throwing callback from success and failure results", async () => {
    const onDiagnostic = vi.fn(() => { throw new Error("private recorder error"); });
    const bridge = new NativeExecutableInsertionBridge("/helper", () => PROOF, onDiagnostic);
    mocks.stdout = '{"accessibility":true,"postEvents":false}';
    await expect(bridge.accessibilityStatus()).resolves.toBe("denied");
    mocks.error = { code: "ENOENT" };
    await expect(bridge.paste(TARGET, 3)).resolves.toEqual({
      status: "failed", reason: "helper_unavailable",
    });
    expect(onDiagnostic).toHaveBeenCalledTimes(2);
  });

  it("isolates an async recorder rejection from insertion", async () => {
    const onDiagnostic = vi.fn(async () => { throw new Error("private recorder error"); });
    const bridge = new NativeExecutableInsertionBridge("/helper", () => PROOF, onDiagnostic);
    mocks.stdout = '{"accessibility":true,"postEvents":true}';
    await expect(bridge.accessibilityStatus()).resolves.toBe("granted");
    mocks.stdout = '{"injected":false,"reason":"permission_denied"}';
    await expect(bridge.paste(TARGET, 3)).resolves.toEqual({
      status: "failed", reason: "permission_denied",
    });
    expect(onDiagnostic).toHaveBeenCalledTimes(2);
  });

  it("wires the service callback through the default helper factory", async () => {
    const onDiagnostic = vi.fn();
    const service = new InsertionService({
      onDiagnostic, platform: "darwin", nativeHelperWorkingDirectory: process.cwd(),
      clipboard: { snapshot: () => ({ restorable: true }), writeText: () => {}, restore: () => {} },
    });
    await expect(service.automaticPasteReady()).resolves.toBe(false);
    expect(onDiagnostic).toHaveBeenCalledWith({
      stage: "insertion", event: "native_helper", outcome: "failed",
      helperCommand: "self-test", detail: "integrity_mismatch",
    });
  });
});
