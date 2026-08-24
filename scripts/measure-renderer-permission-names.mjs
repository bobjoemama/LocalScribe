/**
 * Records the exact permission strings Chromium hands to Electron's permission
 * handlers for the three things LocalScribe's renderers actually do, and proves
 * each one succeeds when that string is the one allowed.
 *
 *   npx electron scripts/measure-renderer-permission-names.mjs
 *
 * `src/main/rendererPermissions.ts` closes Chromium's default grant-everything
 * permission manager and separates metadata checks from operation requests. A
 * wrong permission name does not throw or fail a type check — it silently
 * denies. The second half of this probe applies the Settings policy itself and
 * proves enumeration remains usable while audio capture is rejected.
 *
 * No microphone grant is needed to learn the *name*: Chromium's permission layer
 * runs before any OS capture, so the handler is invoked with its string even
 * when the capture then fails. On a machine that does have an input device this
 * also confirms the call resolves end to end.
 *
 * Conditions here match a packaged renderer deliberately: `file://` (a secure
 * context, which `data:` is not — `navigator.mediaDevices` is simply undefined
 * there), sandboxed, context-isolated. Clipboard writes additionally need
 * document focus and transient user activation, independent of any permission,
 * which is why the window is shown and `executeJavaScript` passes userGesture.
 *
 * `tests/rendererPermissions.test.ts` pins the names this prints.
 */
import { app, BrowserWindow, session } from "electron";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Kept in sync with ALLOWED in src/main/rendererPermissions.ts. */
const EXPECTED = {
  getUserMedia: "media",
  enumerateDeviceLabels: "media",
  clipboardWriteText: "clipboard-sanitized-write",
};

const probeRoot = mkdtempSync(path.join(tmpdir(), "localscribe-permission-"));
const page = path.join(probeRoot, "probe.html");

app.whenReady().then(async () => {
  let exitCode = 1;
  try {
  writeFileSync(page, "<!doctype html><meta charset=utf-8><title>probe</title><body>probe</body>");
  const requested = [];
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    requested.push(permission);
    // Granted so the call proceeds far enough to reveal any follow-on request.
    callback(true);
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => {
    requested.push(permission);
    return true;
  });

  const win = new BrowserWindow({
    show: false,
    width: 240,
    height: 160,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });

  // Load before showing. Showing first races the load and fails with ERR_FAILED.
  await win.loadFile(page);
  win.showInactive();
  win.focus();
  win.webContents.focus();
  await new Promise((resolve) => setTimeout(resolve, 500));

  const seenFor = async (label, expression) => {
    const before = requested.length;
    const outcome = await win.webContents.executeJavaScript(expression, true);
    const names = [...new Set(requested.slice(before))];
    return { label, outcome, names };
  };

  const results = [];
  results.push(await seenFor(
    "enumerateDeviceLabels",
    `(async () => {
       try {
         const devices = await navigator.mediaDevices.enumerateDevices();
         const inputs = devices.filter((device) => device.kind === "audioinput");
         const labelled = inputs.filter((device) => device.label !== "").length;
         return "resolved: " + labelled + "/" + inputs.length + " labelled";
       } catch (error) { return "rejected: " + error.name; }
     })()`,
  ));

  results.push(await seenFor(
    "getUserMedia",
    `(async () => {
       try {
         const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
         const count = stream.getAudioTracks().length;
         for (const track of stream.getTracks()) track.stop();
         return "resolved: " + count + " audio track(s)";
       } catch (error) { return "rejected: " + error.name; }
     })()`,
  ));
  results.push(await seenFor(
    "clipboardWriteText",
    `(async () => {
       try {
         await navigator.clipboard.writeText("localscribe-permission-probe");
         return "resolved";
       } catch (error) { return "rejected: " + error.name; }
     })()`,
  ));
  console.log("renderer call            permission name(s) Chromium asked about   outcome");
  let failed = false;
  for (const { label, outcome, names } of results) {
    const expected = EXPECTED[label];
    const ok = names.includes(expected);
    if (!ok) failed = true;
    console.log(
      `${ok ? " " : "!"} ${label.padEnd(22)} ${names.join(", ").padEnd(38)} ${outcome}`,
    );
    if (!ok) {
      console.log(`    expected ${JSON.stringify(expected)}, which was never asked about.`);
    }
  }

  /*
   * Settings needs audio-input metadata, not a stream. Use a fresh in-memory
   * session so the permissive name-measurement phase cannot cache a grant into
   * this proof. This mirrors the production split: an audio check may pass,
   * while every capture request is answered false.
   */
  const settingsPartition = `localscribe-settings-permission-probe-${process.pid}`;
  const settingsSession = session.fromPartition(settingsPartition);
  const settingsChecks = [];
  const settingsRequests = [];
  settingsSession.setPermissionCheckHandler((_contents, permission, _origin, details) => {
    settingsChecks.push({ permission, ...details });
    return permission === "media"
      && details.isMainFrame
      && details.mediaType === "audio";
  });
  settingsSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    settingsRequests.push({
      permission,
      isMainFrame: details.isMainFrame,
      mediaTypes: "mediaTypes" in details ? details.mediaTypes : undefined,
    });
    callback(false);
  });

  const settingsWindow = new BrowserWindow({
    show: false,
    width: 240,
    height: 160,
    webPreferences: {
      partition: settingsPartition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await settingsWindow.loadFile(page);
  settingsWindow.showInactive();
  settingsWindow.focus();
  settingsWindow.webContents.focus();
  await new Promise((resolve) => setTimeout(resolve, 500));

  const settingsEnumeration = await settingsWindow.webContents.executeJavaScript(
    `(async () => {
       try {
         const devices = await navigator.mediaDevices.enumerateDevices();
         const inputs = devices.filter((device) => device.kind === "audioinput");
         return {
           resolved: true,
           inputCount: inputs.length,
           identifiedCount: inputs.filter((device) => device.deviceId !== "").length,
           labelledCount: inputs.filter((device) => device.label !== "").length,
         };
       } catch (error) {
         return { resolved: false, error: error.name };
       }
     })()`,
    true,
  );
  const settingsCapture = await settingsWindow.webContents.executeJavaScript(
    `(async () => {
       try {
         const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
         for (const track of stream.getTracks()) track.stop();
         return { resolved: true };
       } catch (error) {
         return { resolved: false, error: error.name };
       }
     })()`,
    true,
  );
  settingsWindow.destroy();
  win.destroy();

  const audioMetadataCheckSeen = settingsChecks.some((entry) =>
    entry.permission === "media"
      && entry.isMainFrame
      && entry.mediaType === "audio");
  const audioCaptureRequestSeen = settingsRequests.some((entry) =>
    entry.permission === "media"
      && entry.isMainFrame
      && Array.isArray(entry.mediaTypes)
      && entry.mediaTypes.length === 1
      && entry.mediaTypes[0] === "audio");
  const enumerationUsable = settingsEnumeration.resolved
    && settingsEnumeration.inputCount > 0
    && settingsEnumeration.identifiedCount === settingsEnumeration.inputCount
    && settingsEnumeration.labelledCount === settingsEnumeration.inputCount;
  const captureDenied = !settingsCapture.resolved && audioCaptureRequestSeen;

  console.log("\nSettings split-policy probe");
  console.log(
    `${enumerationUsable ? " " : "!"} enumerateDevices: `
      + `${JSON.stringify(settingsEnumeration)}; audio metadata check seen=${audioMetadataCheckSeen}`,
  );
  console.log(
    `${captureDenied ? " " : "!"} getUserMedia({ audio: true }): `
      + `${JSON.stringify(settingsCapture)}; denied request seen=${audioCaptureRequestSeen}`,
  );
  if (!audioMetadataCheckSeen || !enumerationUsable || !captureDenied) failed = true;

  if (failed) {
    console.log(
      "\nFAIL: a permission the allowlist names is not the one Chromium asks for.\n" +
      "Update src/main/rendererPermissions.ts and the pinned names in\n" +
      "tests/rendererPermissions.test.ts from the trace above.",
    );
    return;
  }
  console.log(
    "\nok: permission names match Chromium, Settings can enumerate labelled " +
    "microphones, and Settings audio capture is denied.",
  );
  exitCode = 0;
  } finally {
    rmSync(probeRoot, { force: true, recursive: true });
    app.exit(exitCode);
  }
}).catch((error) => {
  rmSync(probeRoot, { force: true, recursive: true });
  console.error(error);
  app.exit(1);
});
