#!/usr/bin/env node
/**
 * Scripted macOS integration test for a cold Electron editor.
 *
 * The fixture starts with an already-focused editable Chromium control while
 * Electron's accessibility tree remains cold. The packaged helper alone must
 * activate the tree, return no paste authority from that mutation boundary,
 * and establish authority only through a second fresh target invocation.
 * A DOM paste event proves that the verified control consumed Command-V while
 * preserving arbitrary clipboard data; actual text mutation remains a
 * physical workflow acceptance requirement.
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
  // Electron requires this API after ready. Make the precondition explicit:
  // only the packaged helper's external AXManualAccessibility set may activate
  // Chromium's accessibility tree after the fixture announces readiness.
  app.setAccessibilitySupportEnabled(false);
  const window = new BrowserWindow({ width: 520, height: 240, show: false });
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(\`
    <!doctype html><html><body>
      <div id="editor" contenteditable="true" role="textbox" aria-multiline="true"
        tabindex="0" style="width:420px;height:120px;border:1px solid black"></div>
    </body></html>
  \`));
  window.show();
  app.focus({ steal: true });
  window.focus();
  await window.webContents.executeJavaScript(\`
    (() => {
      const editor = document.getElementById("editor");
      globalThis.__localscribePasteObserved = false;
      editor.addEventListener("paste", () => {
        globalThis.__localscribePasteObserved = true;
      });
      editor.focus();
      return document.activeElement === editor;
    })()
  \`);
  let pasteSignalEmitted = false;
  const pasteObservationTimer = setInterval(() => {
    void window.webContents.executeJavaScript(
      "globalThis.__localscribePasteObserved === true",
    ).then((observed) => {
      if (observed === true && !pasteSignalEmitted) {
        pasteSignalEmitted = true;
        process.stdout.write("localscribe-accessibility-paste-observed\\n");
      }
    }, () => undefined);
  }, 50);
  window.once("closed", () => clearInterval(pasteObservationTimer));
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

  const firstTargetResult = await execFileAsync(helperPath, ["target"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 16 * 1024,
  });
  const firstTarget = parseJSON(firstTargetResult.stdout, "First accessibility target");
  if (
    firstTarget.applicationId !== "com.github.Electron"
    || firstTarget.processId !== child.pid
    || firstTarget.windowFingerprint !== null
    || firstTarget.focusedEditable !== null
    || firstTarget.focusedElementFingerprint !== null
    || firstTarget.accessibilityActivation !== "resolved"
    || firstTarget.accessibilityElement !== "text_control"
    || !Number.isInteger(firstTarget.accessibilityLookupAttempts)
    || firstTarget.accessibilityLookupAttempts < 1
    || firstTarget.accessibilityLookupAttempts > 81
  ) {
    throw new Error("Packaged helper did not activate the cold Electron tree without granting paste authority.");
  }

  const targetResult = await execFileAsync(helperPath, ["target"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 16 * 1024,
  });
  const target = parseJSON(targetResult.stdout, "Second accessibility target");
  if (
    target.applicationId !== firstTarget.applicationId
    || target.processId !== firstTarget.processId
    || target.focusedEditable !== true
    || !/^[a-f0-9]{64}$/u.test(target.windowFingerprint)
    || !/^[a-f0-9]{64}$/u.test(target.focusedElementFingerprint)
    || target.accessibilityActivation !== "not_needed"
    || target.accessibilityElement !== "text_control"
    || target.accessibilityLookupAttempts !== 1
  ) {
    throw new Error("Packaged helper did not establish a fresh target after cold-tree activation.");
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

  // Exercise rejection without modifying the pasteboard. Zero is used for
  // every nonzero current sequence; one is used only when the current sequence
  // is zero, so the stale expectation is always different and representable.
  const staleSequence = sequencePayload.sequence === 0
    ? 1
    : 0;
  const stalePasteResult = await execFileAsync(
    helperPath,
    pasteArgumentsFor(staleSequence),
    { encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 },
  );
  const stalePaste = parseJSON(stalePasteResult.stdout, "Stale-sequence paste");
  if (stalePaste.injected !== false || stalePaste.reason !== "clipboard_changed") {
    throw new Error("Packaged helper did not reject a stale clipboard sequence.");
  }
  // The renderer reports paste consumption on a 50 ms privacy-safe poll. Wait
  // across several polls before asserting the negative stale-dispatch result.
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (stdout.includes("localscribe-accessibility-paste-observed")) {
    throw new Error("Fixture observed a paste event before authorized native dispatch.");
  }

  // Dispatch the user's existing clipboard contents without reading, logging,
  // clearing, or rewriting them. The fixture observes only whether the target
  // consumed Command-V as a DOM paste event; it never reads editor or clipboard
  // content and therefore does not claim that text was inserted.
  const pasteResult = await execFileAsync(
    helperPath,
    pasteArgumentsFor(sequencePayload.sequence),
    { encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 },
  );
  const paste = parseJSON(pasteResult.stdout, "Accessibility paste");
  if (paste.injected !== true) {
    throw new Error("Packaged helper did not dispatch paste into the verified fixture target.");
  }
  const pasteEventObserved = await new Promise((resolve) => {
    if (stdout.includes("localscribe-accessibility-paste-observed")) {
      resolve(true);
      return;
    }
    const poll = setInterval(() => {
      if (stdout.includes("localscribe-accessibility-paste-observed")) {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve(true);
      }
    }, 10);
    const timeout = setTimeout(() => {
      clearInterval(poll);
      resolve(false);
    }, 2_000);
  });
  if (pasteEventObserved !== true) {
    throw new Error("Fixture did not consume native Command-V as a DOM paste event.");
  }

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
    `Packaged helper activated a cold Electron editor after ${firstTarget.accessibilityLookupAttempts} observations; a fresh call established authority; the target consumed native Command-V with clipboard preserved. Physical acceptance must prove text insertion.\n`,
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
