import { describe, expect, it } from "vitest";
import {
  permissionSettingsUrl,
  permissionSnapshotForPlatform,
  runtimeArchitectureFor,
  runtimePlatformFor,
} from "../src/main/platformCapabilities";

describe("macOS permission capabilities", () => {
  it("reports the live readiness of each local input path", () => {
    expect(permissionSnapshotForPlatform("darwin", "granted", false, false, false)).toMatchObject({
      platform: "darwin",
      microphoneSettingsAvailable: true,
      accessibility: { supported: true, granted: false },
      automaticPaste: { supported: true, ready: false },
      globalHold: { supported: true, ready: false },
    });
    expect(permissionSnapshotForPlatform("darwin", "granted", true, true, true)).toMatchObject({
      accessibility: { supported: true, granted: true },
      automaticPaste: { supported: true, ready: true },
      globalHold: { supported: true, ready: true },
    });
  });

  it("reports global toggle readiness independently", () => {
    expect(permissionSnapshotForPlatform("darwin", "denied", false, false, false, true))
      .toMatchObject({
        globalHold: { supported: true, ready: false },
        globalToggle: { supported: true, ready: true },
      });
  });

  it("returns macOS settings deep links", () => {
    expect(permissionSettingsUrl("darwin", "microphone")).toContain("Privacy_Microphone");
    expect(permissionSettingsUrl("darwin", "accessibility")).toContain("Privacy_Accessibility");
  });

  it("rejects unsupported runtime platforms", () => {
    expect(runtimePlatformFor("darwin")).toBe("darwin");
    expect(() => runtimePlatformFor("freebsd")).toThrow(/only macOS/u);
    expect(runtimeArchitectureFor("arm64")).toBe("arm64");
    expect(() => runtimeArchitectureFor("x64")).toThrow(/only Apple Silicon/u);
  });
});
