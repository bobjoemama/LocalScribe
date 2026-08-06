import { describe, expect, it } from "vitest";
import {
  permissionSettingsUrl,
  permissionSnapshotForPlatform,
  runtimePlatformFor,
} from "../src/main/platformCapabilities";

describe("platform-specific permission capabilities", () => {
  it("does not claim macOS global hold or automatic paste until Accessibility is granted", () => {
    expect(permissionSnapshotForPlatform("darwin", "granted", false, false, false)).toMatchObject({
      platform: "darwin",
      microphoneSettingsAvailable: true,
      accessibility: { supported: true, granted: false },
      automaticPaste: { supported: true, ready: false },
      globalHold: { supported: true, ready: false },
    });
  });

  it("describes Windows and unsupported platforms without inventing an Accessibility setting", () => {
    expect(permissionSnapshotForPlatform("win32", "unknown", false, true, true)).toMatchObject({
      accessibility: { supported: false, granted: false },
      automaticPaste: { supported: true, ready: true },
      globalHold: { supported: true, ready: true },
    });
    expect(permissionSnapshotForPlatform("win32", "unknown", false, true, false)).toMatchObject({
      automaticPaste: { supported: true, ready: false },
      globalHold: { supported: true, ready: true },
    });
    expect(permissionSnapshotForPlatform("linux", "unknown", false, true, false)).toMatchObject({
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
    expect(permissionSnapshotForPlatform("darwin", "granted", true, false, false)).toMatchObject({
      accessibility: { supported: true, granted: true },
      automaticPaste: { supported: true, ready: true },
      globalHold: { supported: true, ready: false },
    });
    expect(permissionSnapshotForPlatform("darwin", "granted", false, true, false)).toMatchObject({
      accessibility: { supported: true, granted: false },
      automaticPaste: { supported: true, ready: false },
      globalHold: { supported: true, ready: true },
    });
  });

  /*
   * `globalHold` had a readiness bit from the start; the toggle did not, and it
   * is the shortcut the UI recommends whenever the hold path is unavailable.
   * Without this the renderer had no way to distinguish "Ctrl+Space is bound"
   * from "another app owns Ctrl+Space and we registered nothing".
   */
  it("reports global toggle readiness separately from support", () => {
    expect(permissionSnapshotForPlatform("darwin", "granted", true, true, false, false))
      .toMatchObject({ globalToggle: { supported: true, ready: false } });
    expect(permissionSnapshotForPlatform("darwin", "granted", true, true, false, true))
      .toMatchObject({ globalToggle: { supported: true, ready: true } });
  });

  it("treats toggle readiness as independent of Accessibility and hold readiness", () => {
    // Accessibility denied and the hold monitor dead, but the accelerator did
    // register: the toggle is the user's only remaining shortcut and must not
    // be reported as broken along with the rest.
    expect(permissionSnapshotForPlatform("darwin", "denied", false, false, false, true))
      .toMatchObject({
        accessibility: { supported: true, granted: false },
        globalHold: { supported: true, ready: false },
        globalToggle: { supported: true, ready: true },
      });
    // And the converse: everything else healthy, toggle taken.
    expect(permissionSnapshotForPlatform("darwin", "granted", true, true, false, false))
      .toMatchObject({
        globalHold: { supported: true, ready: true },
        globalToggle: { supported: true, ready: false },
      });
  });

  it("reports toggle readiness on every platform, including where hold is unsupported", () => {
    expect(permissionSnapshotForPlatform("linux", "unknown", false, false, false, false))
      .toMatchObject({
        globalHold: { supported: false, ready: false },
        globalToggle: { supported: true, ready: false },
      });
    expect(permissionSnapshotForPlatform("win32", "unknown", false, true, true, false))
      .toMatchObject({ globalToggle: { supported: true, ready: false } });
  });

  it("normalizes only the runtime platforms LocalScribe handles", () => {
    expect(runtimePlatformFor("darwin")).toBe("darwin");
    expect(runtimePlatformFor("win32")).toBe("win32");
    expect(runtimePlatformFor("freebsd")).toBe("unsupported");
  });
});
