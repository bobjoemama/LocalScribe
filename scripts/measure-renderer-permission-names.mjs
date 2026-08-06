/**
 * Records the exact permission strings Chromium hands to Electron's permission
 * handlers for the three things LocalScribe's renderers actually do, and proves
 * each one succeeds when that string is the one allowed.
 *
 *   npx electron scripts/measure-renderer-permission-names.mjs
 *
 * `src/main/rendererPermissions.ts` closes Chromium's default grant-everything
 * permission manager and reopens one capability at a time, by name. Those names
 * are strings, matched with `includes`. A wrong one does not throw, does not
 * warn, and does not fail any type check — it silently denies. For `media` that
 * means `getUserMedia` rejects and dictation produces nothing at all, which is
 * indistinguishable from a broken microphone.
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
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Kept in sync with ALLOWED in src/main/rendererPermissions.ts. */
const EXPECTED = {
  getUserMedia: "media",
  enumerateDeviceLabels: "media",
  clipboardWriteText: "clipboard-sanitized-write",
};

const page = path.join(mkdtempSync(path.join(tmpdir(), "localscribe-permission-")), "probe.html");
writeFileSync(page, "<!doctype html><meta charset=utf-8><title>probe</title><body>probe</body>");

app.whenReady().then(async () => {
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

  if (failed) {
    console.log(
      "\nFAIL: a permission the allowlist names is not the one Chromium asks for.\n" +
      "Update ALLOWED in src/main/rendererPermissions.ts and the pinned names in\n" +
      "tests/rendererPermissions.test.ts to the names above.",
    );
    app.exit(1);
    return;
  }
  console.log("\nok: every allowlisted name is the name Chromium actually asks for.");
  app.exit(0);
});
