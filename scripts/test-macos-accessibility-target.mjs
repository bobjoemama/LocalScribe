#!/usr/bin/env node
/**
 * Scripted macOS integration test for a cold Electron editor.
 *
 * The fixture starts with focus on a non-editable Chromium control and turns
 * that same control into an editor while the native helper performs its
 * bounded recovery. This deterministically tests rediscovery and fail-closed
 * editability proof; physical targets remain the proof for whether another
 * application's AXManualAccessibility implementation activates its tree.
 *
 * TCC cannot be granted by an unattended test. Without an existing grant this
 * script prints an explicit skip; pass --require-permission when a positive
 * physical-machine result is required.
 */
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const arguments_ = process.argv.slice(2);
const appIndex = arguments_.indexOf("--app");
if (appIndex < 0 || !arguments_[appIndex + 1]) {
  throw new Error("Usage: test-macos-accessibility-target.mjs --app <LocalScribe.app> [--require-permission]");
}
if (process.platform !== "darwin") throw new Error("Accessibility target integration requires macOS.");

const applicationPath = path.resolve(arguments_[appIndex + 1]);
const helperPath = path.join(
  applicationPath,
  "Contents",
  "Resources",
  "native",
  "macos",
  "active-target",
);
const requirePermission = arguments_.includes("--require-permission");
const electronBinary = createRequire(import.meta.url)("electron");
if (typeof electronBinary !== "string" || electronBinary.length === 0) {
  throw new Error("The Electron package did not resolve to an executable path.");
}
const fixtureEnvironment = { ...process.env };
// Some CLI hosts set this globally for their own Electron subprocesses. It
// would turn our fixture into plain Node and bypass Chromium accessibility.
delete fixtureEnvironment.ELECTRON_RUN_AS_NODE;

function parseJSON(output, label) {
  try {
    return JSON.parse(output.trim());
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

const statusResult = await execFileAsync(helperPath, ["accessibility-status"], {
  encoding: "utf8",
  // Code-signature/TCC services can be briefly saturated immediately after a
  // full package-and-sign run. The helper normally returns in milliseconds,
  // but this gate should test correctness rather than machine load jitter.
  timeout: 10_000,
  maxBuffer: 16 * 1024,
});
const status = parseJSON(statusResult.stdout, "Accessibility status");
if (status.accessibility !== true || status.postEvents !== true) {
  const message = "SKIP macOS cold-editor integration: packaged helper lacks Accessibility or event-posting permission.";
  if (requirePermission) throw new Error(message);
  process.stdout.write(`${message}\n`);
  process.exit(0);
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "localscribe-accessibility-fixture-"));
const fixtureMain = `
import electron from "electron";

const { app, BrowserWindow } = electron;

app.setPath("userData", process.env.LOCALSCRIBE_ACCESSIBILITY_FIXTURE_PROFILE);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 520, height: 240, show: false });
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(\`
    <!doctype html><html><body>
      <div id="editor" tabindex="0" style="width:420px;height:120px;border:1px solid black"></div>
    </body></html>
  \`));
  window.show();
  app.focus({ steal: true });
  window.focus();
  await window.webContents.executeJavaScript(\`
    (() => {
      const editor = document.getElementById("editor");
      globalThis.__localscribeInputObserved = false;
      editor.addEventListener("input", () => {
        globalThis.__localscribeInputObserved = true;
      });
      editor.focus();
      return document.activeElement === editor;
    })()
  \`);
  let inputSignalEmitted = false;
  const inputObservationTimer = setInterval(() => {
    void window.webContents.executeJavaScript(
      "globalThis.__localscribeInputObserved === true",
    ).then((observed) => {
      if (observed === true && !inputSignalEmitted) {
        inputSignalEmitted = true;
        process.stdout.write("localscribe-accessibility-input-observed\\n");
      }
    }, () => undefined);
  }, 50);
  window.once("closed", () => clearInterval(inputObservationTimer));
  // Do not announce readiness until AppKit confirms this window is focused.
  // Repeated activation avoids unrelated apps winning the launch-time race.
  let focusAttempts = 0;
  const prepareFixture = () => {
    focusAttempts += 1;
    app.focus({ steal: true });
    window.focus();
    if (!window.isFocused() && focusAttempts < 40) {
      setTimeout(prepareFixture, 50);
      return;
    }
    if (!window.isFocused()) {
      process.stderr.write("fixture-window-never-focused\\n");
      app.exit(3);
      return;
    }
    process.stdout.write("localscribe-accessibility-fixture-ready\\n");
    setTimeout(() => {
      app.setAccessibilitySupportEnabled(true);
      void window.webContents.executeJavaScript(\`
        (() => {
          const editor = document.getElementById("editor");
          editor.setAttribute("contenteditable", "true");
          editor.setAttribute("role", "textbox");
          editor.setAttribute("aria-multiline", "true");
          editor.focus();
        })()
      \`).then(
        () => process.stdout.write("localscribe-accessibility-editor-ready\\n"),
        (error) => process.stderr.write(\`fixture-editor-transition-failed: \${error.message}\\n\`),
      );
    }, 100);
  };
  setTimeout(prepareFixture, 150);
});

process.on("SIGTERM", () => app.quit());
`;

let child;
try {
  await writeFile(path.join(temporaryRoot, "package.json"), JSON.stringify({
    name: "localscribe-accessibility-fixture",
    private: true,
    type: "module",
    main: "main.mjs",
  }));
  await writeFile(path.join(temporaryRoot, "main.mjs"), fixtureMain);

  child = spawn(electronBinary, [temporaryRoot], {
    env: {
      ...fixtureEnvironment,
      LOCALSCRIBE_ACCESSIBILITY_FIXTURE_PROFILE: path.join(temporaryRoot, "profile"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const ready = await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearInterval(poll);
      clearTimeout(timeout);
      child.off("exit", onExit);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Electron accessibility fixture exited early (${code}): ${stderr}`));
    };
    const poll = setInterval(() => {
      if (stdout.includes("localscribe-accessibility-fixture-ready")) {
        cleanup();
        resolve(true);
      }
    }, 10);
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Electron accessibility fixture did not become ready: ${stderr}`));
    }, 8_000);
    child.once("exit", onExit);
  });
  if (ready !== true) throw new Error("Electron accessibility fixture readiness was not confirmed.");

  const targetResult = await execFileAsync(helperPath, ["target"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 16 * 1024,
  });
  const target = parseJSON(targetResult.stdout, "Accessibility target");
  const editorTransitionCompleted = await new Promise((resolve) => {
    if (stdout.includes("localscribe-accessibility-editor-ready")) {
      resolve(true);
      return;
    }
    const poll = setInterval(() => {
      if (stdout.includes("localscribe-accessibility-editor-ready")) {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve(true);
      } else if (stderr.includes("fixture-editor-transition-failed")) {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve(false);
      }
    }, 10);
    const timeout = setTimeout(() => {
      clearInterval(poll);
      resolve(false);
    }, 1_000);
  });
  if (
    target.applicationId !== "com.github.Electron"
    || target.processId !== child.pid
    || target.focusedEditable !== true
    || !/^[a-f0-9]{64}$/u.test(target.windowFingerprint)
    || !/^[a-f0-9]{64}$/u.test(target.focusedElementFingerprint)
    || target.accessibilityActivation !== "resolved"
    || target.accessibilityElement !== "text_control"
    || !Number.isInteger(target.accessibilityLookupAttempts)
    || target.accessibilityLookupAttempts < 2
    || target.accessibilityLookupAttempts > 81
    || editorTransitionCompleted !== true
  ) {
    throw new Error("Packaged helper did not resolve the cold Electron editor within the closed identity boundary.");
  }


  const sequenceResult = await execFileAsync(helperPath, ["clipboard-sequence"], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 16 * 1024,
  });
  const sequencePayload = parseJSON(sequenceResult.stdout, "Clipboard sequence");
  if (!Number.isSafeInteger(sequencePayload.sequence) || sequencePayload.sequence < 0) {
    throw new Error("Packaged helper returned an invalid clipboard sequence.");
  }
  const pasteArgumentsFor = (sequence) => [
    "paste",
    "darwin",
    String(target.processId),
    target.applicationId,
    target.windowFingerprint,
    target.focusedElementFingerprint,
    String(sequence),
  ];

  // Exercise rejection without modifying the pasteboard: an adjacent expected
  // sequence is stale by construction, while the existing clipboard contents
  // and real current sequence remain untouched.
  const staleSequence = sequencePayload.sequence === 0
    ? 1
    : sequencePayload.sequence - 1;
  const stalePasteResult = await execFileAsync(
    helperPath,
    pasteArgumentsFor(staleSequence),
    { encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 },
  );
  const stalePaste = parseJSON(stalePasteResult.stdout, "Stale-sequence paste");
  if (stalePaste.injected !== false || stalePaste.reason !== "clipboard_changed") {
    throw new Error("Packaged helper did not reject a stale clipboard sequence.");
  }

  // Dispatch the user's existing clipboard contents without reading, logging,
  // clearing, or rewriting them. The fixture observes only whether an input
  // event occurred; it never reads the editor value or pasted data.
  const pasteResult = await execFileAsync(
    helperPath,
    pasteArgumentsFor(sequencePayload.sequence),
    { encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 },
  );
  const paste = parseJSON(pasteResult.stdout, "Accessibility paste");
  if (paste.injected !== true) {
    throw new Error("Packaged helper did not dispatch paste into the verified fixture target.");
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  const inputObserved = stdout.includes("localscribe-accessibility-input-observed");

  const finalSequenceResult = await execFileAsync(helperPath, ["clipboard-sequence"], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 16 * 1024,
  });
  const finalSequence = parseJSON(finalSequenceResult.stdout, "Final clipboard sequence");
  if (finalSequence.sequence !== sequencePayload.sequence) {
    throw new Error("Clipboard changed while testing native paste dispatch.");
  }
  process.stdout.write(
    `Packaged helper resolved a cold Electron editor after ${target.accessibilityLookupAttempts} observations; native paste dispatched with clipboard preserved; fixture input event ${inputObserved ? "observed" : "not observed"}.\n`,
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const terminated = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([
      terminated,
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      const killed = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await killed;
    }
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
