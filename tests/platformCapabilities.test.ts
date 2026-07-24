import { describe, expect, it } from "vitest";
import {
  permissionSettingsUrl,
  permissionSnapshotForPlatform,
  runtimePlatformFor,
} from "../src/main/platformCapabilities";

describe("platform-specific permission capabilities", () => {
  it("does not claim macOS global hold or automatic paste until Accessibility is granted", () => {
    expect(permissionSnapshotForPlatform("darwin", "granted", false, false)).toMatchObject({
      platform: "darwin",
      microphoneSettingsAvailable: true,
      accessibility: { supported: true, granted: false },
      automaticPaste: { supported: true, ready: false },
      globalHold: { supported: true, ready: false },
    });
  });

  it("describes Windows and unsupported platforms without inventing an Accessibility setting", () => {
    expect(permissionSnapshotForPlatform("win32", "unknown", false, true)).toMatchObject({
      accessibility: { supported: false, granted: false },
      automaticPaste: { supported: true, ready: true },
      globalHold: { supported: true, ready: true },
    });
    expect(permissionSnapshotForPlatform("linux", "unknown", false, true)).toMatchObject({
      microphoneSettingsAvailable: false,
      automaticPaste: { supported: false, ready: false },
      globalHold: { supported: false, ready: false },
    });
    expect(permissionSettingsUrl("win32", "microphone"))
      .toBe("ms-settings:privacy-microphone");
    expect(permissionSettingsUrl("win32", "accessibility")).toBeNull();
    expect(permissionSettingsUrl("linux", "microphone")).toBeNull();
  });

  it("uses the hook service's proven readiness for macOS global hold", () => {
    expect(permissionSnapshotForPlatform("darwin", "granted", true, false)).toMatchObject({
      accessibility: { supported: true, granted: true },
      automaticPaste: { supported: true, ready: true },
      globalHold: { supported: true, ready: false },
    });
    expect(permissionSnapshotForPlatform("darwin", "granted", false, true)).toMatchObject({
      accessibility: { supported: true, granted: false },
      automaticPaste: { supported: true, ready: false },
      globalHold: { supported: true, ready: true },
    });
  });

  it("normalizes only the runtime platforms LocalScribe handles", () => {
    expect(runtimePlatformFor("darwin")).toBe("darwin");
    expect(runtimePlatformFor("win32")).toBe("win32");
    expect(runtimePlatformFor("freebsd")).toBe("unsupported");
  });
});
