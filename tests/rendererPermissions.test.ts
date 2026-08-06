import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  allowedRendererPermissions,
  rendererPermissionAllowed,
} from "../src/main/rendererPermissions";
import { expectPrecedes, requireIndex } from "./support/order";

/*
 * Electron grants every web permission a renderer asks for unless the app says
 * otherwise, and this app never said otherwise. Every other item on Electron's
 * security checklist is implemented in main — sandbox, contextIsolation,
 * webSecurity, deny-all window open, will-navigate block, packaging fuses — so
 * the renderers holding decrypted transcripts were the ones left open.
 */

/** Everything Chromium can be asked for that this app must never hand out. */
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

describe("what each renderer may be granted", () => {
  it("gives the pill the microphone, because dictation is what it does", () => {
    expect(rendererPermissionAllowed("pill", "media")).toBe(true);
  });

  it("gives Settings the microphone so the device picker can show device names", () => {
    // `enumerateDevices` returns unlabelled entries to a surface that may not
    // hold media access, which makes the microphone list unusable.
    expect(rendererPermissionAllowed("settings", "media")).toBe(true);
  });

  it("does not give the Scratchpad a microphone", () => {
    expect(rendererPermissionAllowed("scratchpad", "media")).toBe(false);
  });

  it("allows clipboard writes where there is a copy button, and nowhere else", () => {
    expect(rendererPermissionAllowed("settings", "clipboard-sanitized-write")).toBe(true);
    expect(rendererPermissionAllowed("scratchpad", "clipboard-sanitized-write")).toBe(true);
    expect(rendererPermissionAllowed("pill", "clipboard-sanitized-write")).toBe(false);
  });

  it("never allows reading the clipboard, on any surface", () => {
    /*
     * Write is a user-initiated copy. Read is the contents of whatever the user
     * last copied anywhere on the machine — passwords included — and no part of
     * this app has a reason to see it.
     */
    for (const surface of ["pill", "settings", "scratchpad"] as const) {
      expect(rendererPermissionAllowed(surface, "clipboard-read"), surface).toBe(false);
    }
  });
});

describe("what nothing may be granted", () => {
  it("denies every permission on the checklist to every surface", () => {
    for (const surface of ["pill", "settings", "scratchpad"] as const) {
      for (const permission of NEVER_GRANTED) {
        expect(rendererPermissionAllowed(surface, permission), `${surface}:${permission}`)
          .toBe(false);
      }
    }
  });

  it("denies a permission it has never heard of rather than defaulting to yes", () => {
    // The failure mode this guards: Electron adds a capability, this file is
    // not updated, and the new capability arrives granted.
    expect(rendererPermissionAllowed("settings", "some-future-capability")).toBe(false);
    expect(rendererPermissionAllowed("pill", "")).toBe(false);
  });

  it("denies everything to a webContents this app did not create", () => {
    // What an injected or unexpected frame looks like at this boundary.
    expect(rendererPermissionAllowed(null, "media")).toBe(false);
    expect(rendererPermissionAllowed(null, "clipboard-sanitized-write")).toBe(false);
  });

  it("keeps each allowance list minimal, so a grant has to be argued for", () => {
    expect(allowedRendererPermissions("pill")).toEqual(["media"]);
    expect(allowedRendererPermissions("scratchpad")).toEqual(["clipboard-sanitized-write"]);
    expect(allowedRendererPermissions("settings")).toHaveLength(2);
  });
});

/*
 * Everything above proves the policy is applied consistently. None of it proves
 * the policy names anything real: `ALLOWED` matches strings with `includes`, so
 * a name Chromium never uses denies silently — no throw, no warning, no type
 * error. For `media` that means `getUserMedia` rejects and dictation produces
 * nothing, which looks exactly like a broken microphone.
 *
 * The names below were observed, not looked up. `scripts/measure-renderer-
 * permission-names.mjs` drives a sandboxed, context-isolated `file://` renderer
 * — the packaged configuration — through the three calls this app makes, and
 * records what Chromium asks the handlers about. Re-run it after an Electron
 * upgrade; it exits non-zero if an allowlisted name is no longer asked for.
 */
const MEASURED_PERMISSION_NAMES: Readonly<Record<string, readonly string[]>> = {
  // getUserMedia({ audio: true }) — resolved with 1 audio track.
  getUserMedia: ["media", "speaker-selection"],
  // enumerateDevices() — resolved with 4/4 inputs labelled.
  enumerateDeviceLabels: ["media", "speaker-selection"],
  // navigator.clipboard.writeText() — resolved.
  clipboardWriteText: ["clipboard-sanitized-write"],
};

describe("the allowlisted names are the names Chromium uses", () => {
  it("names the microphone permission the way getUserMedia asks for it", () => {
    expect(MEASURED_PERMISSION_NAMES["getUserMedia"]).toContain("media");
    expect(allowedRendererPermissions("pill")).toContain("media");
  });

  it("names the clipboard permission the way writeText asks for it", () => {
    expect(MEASURED_PERMISSION_NAMES["clipboardWriteText"]).toContain("clipboard-sanitized-write");
    expect(allowedRendererPermissions("scratchpad")).toContain("clipboard-sanitized-write");
  });

  it("grants nothing beyond what those calls actually ask for", () => {
    /*
     * `speaker-selection` shows up alongside media but is deliberately denied:
     * it gates `setSinkId`, output routing, which this app never does. Recorded
     * so that a future grant has to be argued for rather than copied in because
     * it appeared in a trace next to `media`.
     */
    const asked = new Set(Object.values(MEASURED_PERMISSION_NAMES).flat());
    expect(asked).toContain("speaker-selection");
    for (const surface of ["pill", "settings", "scratchpad"] as const) {
      expect(rendererPermissionAllowed(surface, "speaker-selection"), surface).toBe(false);
    }
  });

  it("has a measured name behind every permission any surface may hold", () => {
    // The direction that catches an invented name: everything granted has to
    // appear in a trace, not just every traced name being handled.
    const granted = new Set(
      (["pill", "settings", "scratchpad"] as const).flatMap((surface) => [
        ...allowedRendererPermissions(surface),
      ]),
    );
    const asked = new Set(Object.values(MEASURED_PERMISSION_NAMES).flat());
    const unmeasured = [...granted].filter((permission) => !asked.has(permission));
    expect(unmeasured, "run scripts/measure-renderer-permission-names.mjs").toEqual([]);
  });
});

describe("the handlers are actually installed", () => {
  const main = readFileSync("src/main.ts", "utf8");

  it("replaces both the request and the check handler", () => {
    /*
     * Installing only one leaves the other answering from Chromium's default
     * manager, which is the behaviour being replaced — `getUserMedia` asks via
     * the request handler, while a synchronous capability query does not.
     */
    expect(main).toContain("setPermissionRequestHandler");
    expect(main).toContain("setPermissionCheckHandler");
    expect(main).toContain("setDisplayMediaRequestHandler");
  });

  it("installs them before any window exists", () => {
    // A window created first can have asked and been granted already. Compared
    // inside the startup sequence, because `createPillWindow` is *defined*
    // earlier in the file than it is called.
    const startup = main.slice(requireIndex(main, "startupPromise = app.whenReady()"));

    expectPrecedes(startup, "installPermissionHandlers();", "pillWindow = createPillWindow()");
  });

  it("routes every answer through the policy rather than a literal", () => {
    const handlers = main.slice(requireIndex(main, "function installPermissionHandlers"));
    const body = handlers.slice(0, requireIndex(handlers, "\nfunction hardenWindow"));

    expect(body.match(/rendererPermissionAllowed\(/gu)).toHaveLength(2);
    expect(body).not.toMatch(/callback\(true\)/u);
  });

  it("answers a null webContents as denied", () => {
    // The check handler's contents argument is nullable, and `null` reaching
    // the policy as an unrecognised surface would still deny — this pins that
    // main does not instead treat it as a trusted internal caller.
    const handlers = main.slice(requireIndex(main, "setPermissionCheckHandler"));

    expect(handlers.slice(0, 200)).toContain("contents !== null");
  });
});
