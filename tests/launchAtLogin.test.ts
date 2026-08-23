import { describe, expect, it } from "vitest";
import {
  launchAtLoginStatusFor,
  loginItemSettings,
  shouldOpenSettingsAtStartup,
} from "../src/main/launchAtLogin";

describe("macOS launch at login", () => {
  it("passes the requested registration state directly to Electron", () => {
    expect(loginItemSettings(true)).toEqual({ openAtLogin: true });
    expect(loginItemSettings(false)).toEqual({ openAtLogin: false });
  });

  it("reports approval-required login items truthfully", () => {
    expect(launchAtLoginStatusFor({
      openAtLogin: true,
      status: "requires-approval",
    })).toEqual({
      supported: true,
      registered: true,
      effective: false,
      requiresApproval: true,
      status: "requires-approval",
    });
  });

  it("reports effective and disabled registrations", () => {
    expect(launchAtLoginStatusFor({ openAtLogin: true, status: "enabled" }).effective).toBe(true);
    expect(launchAtLoginStatusFor({ openAtLogin: true, status: "not-registered" }).status)
      .toBe("disabled");
  });

  it("opens Settings only for a normal launch", () => {
    expect(shouldOpenSettingsAtStartup(false)).toBe(true);
    expect(shouldOpenSettingsAtStartup(true)).toBe(false);
  });
});
