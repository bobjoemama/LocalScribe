import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  launchAtLoginStatusFor,
  loginItemQueryOptions,
  loginItemSettings,
  shouldOpenSettingsAtStartup,
  WINDOWS_APP_USER_MODEL_ID,
  WINDOWS_HIDDEN_STARTUP_ARGUMENT,
} from "../src/main/windowsLifecycle";

describe("Windows lifecycle configuration", () => {
  it("registers the portable executable with a hidden-startup argument", () => {
    expect(loginItemSettings(
      true,
      "win32",
      "C:\\Tools\\LocalScribe\\LocalScribe.exe",
    )).toEqual({
      openAtLogin: true,
      path: "C:\\Tools\\LocalScribe\\LocalScribe.exe",
      args: [WINDOWS_HIDDEN_STARTUP_ARGUMENT],
    });
    expect(loginItemSettings(
      false,
      "win32",
      "C:\\Tools\\LocalScribe\\LocalScribe.exe",
    )).toEqual({
      openAtLogin: false,
      path: "C:\\Tools\\LocalScribe\\LocalScribe.exe",
      args: [WINDOWS_HIDDEN_STARTUP_ARGUMENT],
    });
  });

  it("rejects ambiguous Windows login executable paths", () => {
    expect(() => loginItemSettings(true, "win32", "LocalScribe.exe"))
      .toThrow("absolute executable path");
    expect(() => loginItemSettings(true, "win32", "C:\\Tools\\LocalScribe"))
      .toThrow("absolute executable path");
  });

  it("queries the same executable and arguments that Windows startup registration uses", () => {
    expect(loginItemQueryOptions(
      "win32",
      "C:\\Tools\\LocalScribe\\LocalScribe.exe",
    )).toEqual({
      path: "C:\\Tools\\LocalScribe\\LocalScribe.exe",
      args: [WINDOWS_HIDDEN_STARTUP_ARGUMENT],
    });
    expect(loginItemQueryOptions("darwin", "/Applications/LocalScribe.app")).toBeUndefined();
  });

  it("reports macOS approval and Windows external disablement as ineffective", () => {
    expect(launchAtLoginStatusFor("darwin", {
      openAtLogin: true,
      status: "requires-approval",
    })).toEqual({
      supported: true,
      registered: true,
      effective: false,
      requiresApproval: true,
      status: "requires-approval",
    });
    expect(launchAtLoginStatusFor("win32", {
      openAtLogin: true,
      executableWillLaunchAtLogin: false,
    })).toEqual({
      supported: true,
      registered: true,
      effective: false,
      requiresApproval: false,
      status: "disabled",
    });
    expect(launchAtLoginStatusFor("win32", {
      openAtLogin: true,
      executableWillLaunchAtLogin: true,
    })).toEqual({
      supported: true,
      registered: true,
      effective: true,
      requiresApproval: false,
      status: "enabled",
    });
  });

  it("starts Windows login launches tray-only while preserving normal and macOS startup", () => {
    expect(shouldOpenSettingsAtStartup(
      "win32",
      ["LocalScribe.exe", WINDOWS_HIDDEN_STARTUP_ARGUMENT],
      false,
    )).toBe(false);
    expect(shouldOpenSettingsAtStartup("win32", ["LocalScribe.exe"], true)).toBe(true);
    expect(shouldOpenSettingsAtStartup("darwin", ["LocalScribe"], true)).toBe(false);
    expect(shouldOpenSettingsAtStartup("darwin", ["LocalScribe"], false)).toBe(true);
  });

  it("uses a stable portable app identity instead of a Squirrel-only identity", () => {
    expect(WINDOWS_APP_USER_MODEL_ID).toBe("com.localscribe.desktop");
    expect(WINDOWS_APP_USER_MODEL_ID).not.toContain("squirrel");
  });

  it("sets the stable Windows identity before legacy uninstall cleanup", () => {
    const main = readFileSync(path.resolve("src/main.ts"), "utf8");
    expect(main.indexOf("app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID)"))
      .toBeLessThan(main.indexOf('process.argv.includes("--squirrel-uninstall")'));
  });
});
