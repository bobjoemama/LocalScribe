import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  allowedRendererPermissionChecks,
  allowedRendererPermissionRequests,
  rendererPermissionCheckAllowed,
  rendererPermissionRequestAllowed,
} from "../src/main/rendererPermissions";
import { expectPrecedes, requireIndex } from "./support/order";

const MAIN_AUDIO_CHECK = { isMainFrame: true, mediaType: "audio" } as const;
const MAIN_AUDIO_REQUEST = { isMainFrame: true, mediaTypes: ["audio"] } as const;
const MAIN_FRAME = { isMainFrame: true } as const;

/** Everything Chromium can ask for that LocalScribe must never hand out. */
const NEVER_GRANTED = [
  "clipboard-read",
  "notifications",
  "geolocation",
  "midi",
  "midiSysex",
  "pointerLock",
  "fullscreen",
  "openExternal",
  "window-management",
  "display-capture",
  "idle-detection",
  "storage-access",
  "hid",
  "serial",
  "usb",
  "speaker-selection",
  "keyboardLock",
  "fileSystem",
  "unknown",
] as const;

describe("media permission checks", () => {
  it("allows audio metadata checks only in the Pill and Settings main frames", () => {
    expect(rendererPermissionCheckAllowed("pill", "media", MAIN_AUDIO_CHECK)).toBe(true);
    expect(rendererPermissionCheckAllowed("settings", "media", MAIN_AUDIO_CHECK)).toBe(true);
    expect(rendererPermissionCheckAllowed("scratchpad", "media", MAIN_AUDIO_CHECK)).toBe(false);
    expect(rendererPermissionCheckAllowed(null, "media", MAIN_AUDIO_CHECK)).toBe(false);
  });

  it("denies camera and unknown media checks everywhere", () => {
    for (const surface of ["pill", "settings", "scratchpad"] as const) {
      for (const mediaType of ["video", "unknown", undefined] as const) {
        expect(
          rendererPermissionCheckAllowed(surface, "media", { isMainFrame: true, mediaType }),
          `${surface}:${String(mediaType)}`,
        ).toBe(false);
      }
    }
  });

  it("denies even an audio check from a subframe", () => {
    expect(rendererPermissionCheckAllowed("pill", "media", {
      isMainFrame: false,
      mediaType: "audio",
    })).toBe(false);
    expect(rendererPermissionCheckAllowed("settings", "media", {
      isMainFrame: false,
      mediaType: "audio",
    })).toBe(false);
  });
});

describe("media permission requests", () => {
  it("lets the Pill main frame request exactly audio-only capture", () => {
    expect(rendererPermissionRequestAllowed("pill", "media", MAIN_AUDIO_REQUEST)).toBe(true);
  });

  it("never lets Settings request capture, despite its audio metadata check", () => {
    expect(rendererPermissionRequestAllowed("settings", "media", MAIN_AUDIO_REQUEST)).toBe(false);
    expect(rendererPermissionRequestAllowed("settings", "media", {
      isMainFrame: true,
      mediaTypes: ["video"],
    })).toBe(false);
  });

  it("denies video, mixed, missing, duplicated, and subframe Pill requests", () => {
    for (const mediaTypes of [
      ["video"],
      ["audio", "video"],
      ["audio", "audio"],
      [],
      undefined,
    ] as const) {
      expect(
        rendererPermissionRequestAllowed("pill", "media", {
          isMainFrame: true,
          mediaTypes,
        }),
        JSON.stringify(mediaTypes),
      ).toBe(false);
    }
    expect(rendererPermissionRequestAllowed("pill", "media", {
      isMainFrame: false,
      mediaTypes: ["audio"],
    })).toBe(false);
  });

  it("denies capture to Scratchpad and unknown webContents", () => {
    expect(rendererPermissionRequestAllowed("scratchpad", "media", MAIN_AUDIO_REQUEST)).toBe(false);
    expect(rendererPermissionRequestAllowed(null, "media", MAIN_AUDIO_REQUEST)).toBe(false);
  });
});

describe("non-media renderer permissions", () => {
  it("allows clipboard writes where there is a Copy control, and nowhere else", () => {
    for (const surface of ["settings", "scratchpad"] as const) {
      expect(rendererPermissionCheckAllowed(surface, "clipboard-sanitized-write", MAIN_FRAME))
        .toBe(true);
      expect(rendererPermissionRequestAllowed(surface, "clipboard-sanitized-write", MAIN_FRAME))
        .toBe(true);
    }
    expect(rendererPermissionCheckAllowed("pill", "clipboard-sanitized-write", MAIN_FRAME))
      .toBe(false);
    expect(rendererPermissionRequestAllowed("pill", "clipboard-sanitized-write", MAIN_FRAME))
      .toBe(false);
  });

  it("denies all permissions to every subframe", () => {
    for (const surface of ["pill", "settings", "scratchpad"] as const) {
      expect(rendererPermissionCheckAllowed(surface, "clipboard-sanitized-write", {
        isMainFrame: false,
      })).toBe(false);
      expect(rendererPermissionRequestAllowed(surface, "clipboard-sanitized-write", {
        isMainFrame: false,
      })).toBe(false);
    }
  });

  it("never grants clipboard reads or any unrecognised/checklist capability", () => {
    for (const surface of ["pill", "settings", "scratchpad"] as const) {
      for (const permission of NEVER_GRANTED) {
        expect(
          rendererPermissionCheckAllowed(surface, permission, MAIN_FRAME),
          `check:${surface}:${permission}`,
        ).toBe(false);
        expect(
          rendererPermissionRequestAllowed(surface, permission, MAIN_FRAME),
          `request:${surface}:${permission}`,
        ).toBe(false);
      }
    }
  });

  it("keeps the two boundary allowlists minimal and explicit", () => {
    expect(allowedRendererPermissionChecks("pill")).toEqual(["media"]);
    expect(allowedRendererPermissionRequests("pill")).toEqual(["media"]);
    expect(allowedRendererPermissionChecks("settings"))
      .toEqual(["media", "clipboard-sanitized-write"]);
    expect(allowedRendererPermissionRequests("settings"))
      .toEqual(["clipboard-sanitized-write"]);
    expect(allowedRendererPermissionChecks("scratchpad"))
      .toEqual(["clipboard-sanitized-write"]);
    expect(allowedRendererPermissionRequests("scratchpad"))
      .toEqual(["clipboard-sanitized-write"]);
  });
});

/*
 * The names below were observed by scripts/measure-renderer-permission-names.mjs
 * in a sandboxed, context-isolated renderer. Re-run the probe after Electron
 * upgrades: an invented permission string silently denies the feature.
 */
const MEASURED_PERMISSION_NAMES: Readonly<Record<string, readonly string[]>> = {
  getUserMedia: ["media", "speaker-selection"],
  enumerateDeviceLabels: ["media", "speaker-selection"],
  clipboardWriteText: ["clipboard-sanitized-write"],
};

describe("the allowlisted names are the names Chromium uses", () => {
  it("names microphone and clipboard capabilities from empirical traces", () => {
    expect(MEASURED_PERMISSION_NAMES.getUserMedia).toContain("media");
    expect(MEASURED_PERMISSION_NAMES.clipboardWriteText)
      .toContain("clipboard-sanitized-write");
  });

  it("has a measured name behind every permission either boundary can pass", () => {
    const granted = new Set(
      (["pill", "settings", "scratchpad"] as const).flatMap((surface) => [
        ...allowedRendererPermissionChecks(surface),
        ...allowedRendererPermissionRequests(surface),
      ]),
    );
    const asked = new Set(Object.values(MEASURED_PERMISSION_NAMES).flat());
    expect([...granted].filter((permission) => !asked.has(permission)))
      .toEqual([]);
  });

  it("deliberately denies output-device routing even though Chromium asks about it", () => {
    expect(new Set(Object.values(MEASURED_PERMISSION_NAMES).flat()))
      .toContain("speaker-selection");
    for (const surface of ["pill", "settings", "scratchpad"] as const) {
      expect(rendererPermissionCheckAllowed(surface, "speaker-selection", MAIN_FRAME)).toBe(false);
      expect(rendererPermissionRequestAllowed(surface, "speaker-selection", MAIN_FRAME)).toBe(false);
    }
  });
});

describe("the handlers are actually installed", () => {
  const main = readFileSync("src/main.ts", "utf8");

  it("replaces request, check, and display-capture handlers", () => {
    expect(main).toContain("setPermissionRequestHandler");
    expect(main).toContain("setPermissionCheckHandler");
    expect(main).toContain("setDisplayMediaRequestHandler");
  });

  it("installs them before any window exists", () => {
    const startup = main.slice(requireIndex(main, "startupPromise = app.whenReady()"));
    expectPrecedes(startup, "installPermissionHandlers();", "pillWindow = createPillWindow()");
  });

  it("routes request and check details through their distinct policies", () => {
    const handlers = main.slice(requireIndex(main, "function installPermissionHandlers"));
    const body = handlers.slice(0, requireIndex(handlers, "\nfunction hardenWindow"));

    expect(body).toContain("rendererPermissionRequestAllowed(");
    expect(body).toContain("rendererPermissionCheckAllowed(");
    expect(body).toContain("details.isMainFrame");
    expect(body).toContain("details.mediaTypes");
    expect(body).toContain("details.mediaType");
    expect(body).not.toMatch(/callback\(true\)/u);
  });

  it("answers a null webContents as denied", () => {
    const handlers = main.slice(requireIndex(main, "setPermissionCheckHandler"));
    expect(handlers.slice(0, 260)).toContain("contents !== null");
  });
});
