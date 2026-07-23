import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseControlMonitorLine } from "../src/main/hotkeys/macControlMonitor";
import { resolveNativeActiveTargetHelperPath } from "../src/main/nativeHelperPath";

describe("macOS Control monitor protocol", () => {
  it("accepts only the four non-content key-state events", () => {
    expect(parseControlMonitorLine('{"event":"control-down"}')).toBe("control-down");
    expect(parseControlMonitorLine('{"event":"control-up"}')).toBe("control-up");
    expect(parseControlMonitorLine('{"event":"space-down"}')).toBe("space-down");
    expect(parseControlMonitorLine('{"event":"modified-input"}')).toBe("modified-input");
  });

  it("rejects malformed, extra, and content-bearing payloads", () => {
    expect(parseControlMonitorLine("not json")).toBeNull();
    expect(parseControlMonitorLine('{"event":"key-down","key":"A"}')).toBeNull();
    expect(parseControlMonitorLine('{"event":"control-down","key":"Control"}')).toBeNull();
  });
});

describe("native active-target helper resolution", () => {
  it("uses the explicit development override for both insertion and Control monitoring", () => {
    const override = path.resolve("test-fixtures", "test-helper");
    expect(resolveNativeActiveTargetHelperPath({
      platform: "darwin",
      environment: { LOCALSCRIBE_NATIVE_INSERTION_HELPER: override },
      allowEnvironmentOverride: true,
    })).toBe(override);
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
