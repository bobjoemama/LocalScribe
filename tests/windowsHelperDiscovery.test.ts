import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  NATIVE_ACTIVE_TARGET_HELPER_OVERRIDE,
  resolveNativeActiveTargetHelperPath,
} from "../src/main/nativeHelperPath";

describe("Windows native helper discovery", () => {
  it("prefers the packaged x64 helper over a source-tree executable", () => {
    const resourcesPath = path.resolve("test-fixtures", "bundle", "resources");
    const workingDirectory = path.resolve("test-fixtures", "workspace");
    const packaged = path.join(resourcesPath, "native", "windows", "active-target.exe");
    expect(resolveNativeActiveTargetHelperPath({
      platform: "win32",
      environment: {},
      resourcesPath,
      workingDirectory,
      exists: (candidate) => candidate === packaged,
    })).toBe(packaged);
  });

  it("finds the source-tree helper for Windows development", () => {
    const resourcesPath = path.resolve("test-fixtures", "bundle", "resources");
    const workingDirectory = path.resolve("test-fixtures", "workspace");
    const development = path.join(
      workingDirectory,
      "resources",
      "native",
      "windows",
      "active-target.exe",
    );
    expect(resolveNativeActiveTargetHelperPath({
      platform: "win32",
      environment: {},
      resourcesPath,
      workingDirectory,
      exists: (candidate) => candidate === development,
    })).toBe(development);
  });

  it("does not accept a helper environment override unless explicitly enabled", () => {
    const resourcesPath = path.resolve("test-fixtures", "bundle", "resources");
    const workingDirectory = path.resolve("test-fixtures", "workspace");
    const packaged = path.join(resourcesPath, "native", "windows", "active-target.exe");
    expect(resolveNativeActiveTargetHelperPath({
      platform: "win32",
      environment: {
        [NATIVE_ACTIVE_TARGET_HELPER_OVERRIDE]: path.resolve(
          "test-fixtures",
          "untrusted",
          "active-target.exe",
        ),
      },
      allowEnvironmentOverride: false,
      resourcesPath,
      workingDirectory,
      exists: (candidate) => candidate === packaged,
    })).toBe(packaged);
  });
});
