import { describe, expect, it } from "vitest";
import {
  NATIVE_ACTIVE_TARGET_HELPER_OVERRIDE,
  resolveNativeActiveTargetHelperPath,
} from "../src/main/nativeHelperPath";

describe("Windows native helper discovery", () => {
  it("prefers the packaged x64 helper over a source-tree executable", () => {
    const packaged = "/bundle/resources/native/windows/active-target.exe";
    expect(resolveNativeActiveTargetHelperPath({
      platform: "win32",
      environment: {},
      resourcesPath: "/bundle/resources",
      workingDirectory: "/workspace",
      exists: (candidate) => candidate === packaged,
    })).toBe(packaged);
  });

  it("finds the source-tree helper for Windows development", () => {
    const development = "/workspace/resources/native/windows/active-target.exe";
    expect(resolveNativeActiveTargetHelperPath({
      platform: "win32",
      environment: {},
      resourcesPath: "/bundle/resources",
      workingDirectory: "/workspace",
      exists: (candidate) => candidate === development,
    })).toBe(development);
  });

  it("does not accept a helper environment override unless explicitly enabled", () => {
    const packaged = "/bundle/resources/native/windows/active-target.exe";
    expect(resolveNativeActiveTargetHelperPath({
      platform: "win32",
      environment: {
        [NATIVE_ACTIVE_TARGET_HELPER_OVERRIDE]: "/untrusted/active-target.exe",
      },
      allowEnvironmentOverride: false,
      resourcesPath: "/bundle/resources",
      workingDirectory: "/workspace",
      exists: (candidate) => candidate === packaged,
    })).toBe(packaged);
  });
});
