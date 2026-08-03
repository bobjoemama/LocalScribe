#!/usr/bin/env node
/**
 * Browser-layout regression for the Settings modal.
 *
 * Vite bundles the actual React SettingsModal and CSS, then Electron's
 * Chromium renderer measures scrolling at the supported desktop dimensions.
 * It deliberately does not drive the product app or make network calls.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { SETTINGS_WINDOW_LAYOUT } from "../src/shared/windowLayout.mts";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "localscribe-settings-layout-"));
const renderedDirectory = resolve(temporaryRoot, "renderer");
const resultFile = resolve(temporaryRoot, "result.json");
const electronMainFile = resolve(temporaryRoot, "electron-main.mjs");
const inlineHarnessFile = resolve(temporaryRoot, "settings-layout-harness.inline.html");
const settingsWindowSizes = [
  [SETTINGS_WINDOW_LAYOUT.defaultWidth, SETTINGS_WINDOW_LAYOUT.defaultHeight],
  [SETTINGS_WINDOW_LAYOUT.minimumWidth, SETTINGS_WINDOW_LAYOUT.minimumHeight],
];

const rendererSource = resolve(repository, "scripts/settings-layout-harness.html");
const electronBinary = process.platform === "darwin"
  ? resolve(repository, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
  : resolve(repository, "node_modules/electron/dist/electron");

const electronMain = `
import { app, BrowserWindow, protocol, session } from "electron";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const harnessFile = process.env.LOCALSCRIBE_SCROLL_HARNESS_FILE;
const resultFile = process.env.LOCALSCRIBE_SCROLL_RESULT_FILE;
const stageFile = \`${resultFile}.stage\`;
const stage = (message) => appendFileSync(stageFile, \`${new Date().toISOString()} \${message}\\n\`);
stage("module-loaded");
protocol.registerSchemesAsPrivileged([{
  scheme: "localscribe-layout-test",
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);
app.on("will-finish-launching", () => stage("will-finish-launching"));
app.on("ready", () => stage("ready-event"));
app.on("child-process-gone", (_event, details) => stage(\`child-process-gone type=\${details.type} reason=\${details.reason} exit=\${details.exitCode}\`));
app.on("before-quit", () => stage("before-quit"));
let allowQuit = false;
app.on("window-all-closed", (event) => {
  stage("window-all-closed");
  if (!allowQuit) event.preventDefault();
});

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function inspectTab(window, label, targetText) {
  return window.webContents.executeJavaScript(\`(async () => {
    const waitForPaint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const button = [...document.querySelectorAll(".ls-settings-sidebar nav button")]
      .find((candidate) => candidate.textContent?.trim() === \${JSON.stringify(label)});
    if (!button) throw new Error("Missing settings tab: \${label}");
    button.click();
    await waitForPaint();

    const scroll = document.querySelector(".ls-settings-scroll");
    const header = document.querySelector(".ls-settings-header");
    const footer = document.querySelector(".ls-settings-footer");
    if (!(scroll instanceof HTMLElement) || !(header instanceof HTMLElement) || !(footer instanceof HTMLElement)) {
      throw new Error("Settings layout chrome is missing for \${label}");
    }
    const target = [...scroll.querySelectorAll("button, strong, small, span, p")]
      .filter((candidate) => candidate.textContent?.trim() === \${JSON.stringify(targetText)})
      .at(-1);
    if (!(target instanceof HTMLElement)) throw new Error("Missing \${label} target: \${targetText}");

    scroll.scrollTop = 0;
    await waitForPaint();
    const before = {
      scrollTop: scroll.scrollTop,
      scrollHeight: scroll.scrollHeight,
      clientHeight: scroll.clientHeight,
      headerTop: header.getBoundingClientRect().top,
      footerTop: footer.getBoundingClientRect().top,
    };
    scroll.scrollTop = scroll.scrollHeight;
    scroll.dispatchEvent(new Event("scroll"));
    await waitForPaint();
    const viewport = scroll.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    const after = {
      scrollTop: scroll.scrollTop,
      maxScrollTop: Math.max(0, scroll.scrollHeight - scroll.clientHeight),
      headerTop: header.getBoundingClientRect().top,
      footerTop: footer.getBoundingClientRect().top,
      targetTop: targetBounds.top,
      targetBottom: targetBounds.bottom,
      viewportTop: viewport.top,
      viewportBottom: viewport.bottom,
    };
    const footerControls = [...footer.querySelectorAll("button")].map((control) => {
      const bounds = control.getBoundingClientRect();
      return {
        label: control.textContent?.trim(),
        disabled: control.disabled,
        visible: bounds.top >= 0 && bounds.bottom <= window.innerHeight,
      };
    });
    const modelControls = {
      modes: [],
      actions: [],
      copy: "",
      sharedLabels: 0,
    };
    const rowControl = (rowLabel) => {
      const row = [...scroll.querySelectorAll(".ls-settings-row")].find((candidate) => (
        candidate.querySelector("strong")?.textContent?.trim() === rowLabel
      ));
      const input = row?.querySelector("input");
      const select = row?.querySelector("select");
      return {
        found: Boolean(row),
        checked: input?.type === "checkbox" ? input.checked : null,
        value: select?.value ?? input?.value ?? null,
        selectedLabel: select?.selectedOptions[0]?.textContent?.trim() ?? null,
        detail: row?.querySelector("small")?.textContent?.trim() ?? null,
      };
    };
    const settingsBindings = {};
    if (\${JSON.stringify(label)} === "General") {
      settingsBindings.microphone = rowControl("Microphone");
      settingsBindings.language = rowControl("Dictation language");
      settingsBindings.holdShortcut = scroll.querySelector("[data-shortcut-kind='hold'] button")
        ?.getAttribute("aria-label") ?? null;
      settingsBindings.toggleShortcut = scroll.querySelector("[data-shortcut-kind='toggle'] button")
        ?.getAttribute("aria-label") ?? null;
    } else if (\${JSON.stringify(label)} === "System") {
      for (const rowLabel of [
        "Launch at login",
        "Show floating bar",
        "Paste automatically",
        "Save transcript history",
        "History retention",
      ]) {
        settingsBindings[rowLabel] = rowControl(rowLabel);
      }
    } else if (\${JSON.stringify(label)} === "Writing") {
      for (const rowLabel of ["Remove filler words", "Spoken commands", "Smart punctuation"]) {
        settingsBindings[rowLabel] = rowControl(rowLabel);
      }
      settingsBindings.copy = scroll.textContent ?? "";
    }
    if (\${JSON.stringify(label)} === "Model & Performance") {
      const modeInputs = [...scroll.querySelectorAll("input[name='model-performance-mode']")];
      for (const input of modeInputs) {
        const control = input.closest("label");
        if (!(control instanceof HTMLElement)) continue;
        control.scrollIntoView({ block: "nearest" });
        await waitForPaint();
        const bounds = control.getBoundingClientRect();
        const controlViewport = scroll.getBoundingClientRect();
        modelControls.modes.push({
          value: input.value,
          checked: input.checked,
          visible: bounds.top >= controlViewport.top - 1 && bounds.bottom <= controlViewport.bottom + 1,
        });
      }
      const actionButtons = [...scroll.querySelectorAll(
        "button[aria-label^='Download'], button[aria-label^='Repair'], button[aria-label^='Remove']",
      )];
      for (const control of actionButtons) {
        control.scrollIntoView({ block: "nearest" });
        await waitForPaint();
        const bounds = control.getBoundingClientRect();
        const controlViewport = scroll.getBoundingClientRect();
        modelControls.actions.push({
          label: control.getAttribute("aria-label"),
          visible: bounds.top >= controlViewport.top - 1 && bounds.bottom <= controlViewport.bottom + 1,
        });
      }
      modelControls.copy = scroll.textContent ?? "";
      modelControls.sharedLabels = [...scroll.querySelectorAll(".ls-model-shared-label")]
        .filter((node) => node.textContent?.includes("Shared artifact")).length;
    }
    return {
      label: \${JSON.stringify(label)},
      targetText: \${JSON.stringify(targetText)},
      before,
      after,
      footerControls,
      modelControls,
      settingsBindings,
    };
  })()\`);
}

async function exerciseChangedSettings(window) {
  return window.webContents.executeJavaScript(\`(async () => {
    const waitForPaint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const openTab = async (label) => {
      const button = [...document.querySelectorAll(".ls-settings-sidebar nav button")]
        .find((candidate) => candidate.textContent?.trim() === label);
      if (!button) throw new Error("Missing settings tab while exercising save: " + label);
      button.click();
      await waitForPaint();
    };
    const row = (label) => [...document.querySelectorAll(".ls-settings-row")].find((candidate) => (
      candidate.querySelector("strong")?.textContent?.trim() === label
    ));

    await openTab("General");
    const language = row("Dictation language")?.querySelector("select");
    if (!(language instanceof HTMLSelectElement)) throw new Error("Missing dictation language select");
    language.value = "German";
    language.dispatchEvent(new Event("change", { bubbles: true }));

    await openTab("System");
    const launchAtLogin = row("Launch at login")?.querySelector("input");
    const showPill = row("Show floating bar")?.querySelector("input");
    const autoPaste = row("Paste automatically")?.querySelector("input");
    const retention = row("History retention")?.querySelector("select");
    if (!(launchAtLogin instanceof HTMLInputElement)
      || !(showPill instanceof HTMLInputElement) || !(autoPaste instanceof HTMLInputElement)
      || !(retention instanceof HTMLSelectElement)) {
      throw new Error("Missing editable System settings controls");
    }
    launchAtLogin.click();
    showPill.click();
    autoPaste.click();
    retention.value = "7";
    retention.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForPaint();

    const save = [...document.querySelectorAll(".ls-settings-footer button")]
      .find((candidate) => candidate.textContent?.trim() === "Save changes");
    if (!(save instanceof HTMLButtonElement)) throw new Error("Missing Save changes button");
    save.click();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (window.__localScribeSettingsHarness.patchCalls.length > 0
        && !save.textContent?.includes("Saving")) break;
    }
    const beforeReload = {
      patchCalls: window.__localScribeSettingsHarness.patchCalls,
      persisted: window.__localScribeSettingsHarness.persisted(),
      status: document.querySelector(".ls-settings-footer [role='status']")?.textContent?.trim() ?? "",
    };

    window.__localScribeSettingsHarness.remount();
    await waitForPaint();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await openTab("System");
    const reloadedRow = (label) => [...document.querySelectorAll(".ls-settings-row")].find((candidate) => (
      candidate.querySelector("strong")?.textContent?.trim() === label
    ));
    const reloadedLanguage = async () => {
      await openTab("General");
      return reloadedRow("Dictation language")?.querySelector("select")?.value ?? null;
    };
    const afterReload = {
      launchAtLogin: reloadedRow("Launch at login")?.querySelector("input")?.checked ?? null,
      showPillWhenIdle: reloadedRow("Show floating bar")?.querySelector("input")?.checked ?? null,
      autoPaste: reloadedRow("Paste automatically")?.querySelector("input")?.checked ?? null,
      historyRetentionDays: reloadedRow("History retention")?.querySelector("select")?.value ?? null,
      language: await reloadedLanguage(),
    };
    return { beforeReload, afterReload };
  })()\`);
}

async function exerciseModelSelection(window, expectedResult) {
  return window.webContents.executeJavaScript(\`(async () => {
    const waitForPaint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const openModel = [...document.querySelectorAll(".ls-settings-sidebar nav button")]
      .find((candidate) => candidate.textContent?.trim() === "Model & Performance");
    if (!(openModel instanceof HTMLButtonElement)) throw new Error("Missing Model & Performance tab");
    openModel.click();
    await waitForPaint();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const qwenCard = [...document.querySelectorAll(".ls-model-family-card")]
      .find((candidate) => candidate.querySelector("h3")?.textContent?.trim() === "Qwen3-ASR 1.7B");
    const selectQwen = [...(qwenCard?.querySelectorAll("button") ?? [])]
      .find((candidate) => candidate.textContent?.trim() === "Select");
    if (!(selectQwen instanceof HTMLButtonElement)) throw new Error("Missing Qwen family Select button");
    selectQwen.click();
    await waitForPaint();
    const low = document.querySelector("input[name='model-performance-mode'][value='low']");
    if (!(low instanceof HTMLInputElement)) throw new Error("Missing Low performance choice");
    low.click();
    await waitForPaint();
    const beforeApply = {
      applyCalls: [...window.__localScribeSettingsHarness.applyCalls],
      patchCalls: [...window.__localScribeSettingsHarness.patchCalls],
      summary: document.querySelector(".ls-model-apply-card")?.textContent ?? "",
    };
    const apply = [...document.querySelectorAll(".ls-model-apply-card button")]
      .find((candidate) => candidate.textContent?.trim() === "Apply model");
    if (!(apply instanceof HTMLButtonElement)) throw new Error("Missing Apply model button");
    const enabledBeforeClick = !apply.disabled;
    apply.click();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (window.__localScribeSettingsHarness.applyCalls.length === 1
        && !apply.textContent?.includes("Applying")) break;
    }
    const selectionInputs = [...document.querySelectorAll("input[name='model-performance-mode']")];
    return {
      expectedResult: \${JSON.stringify(expectedResult)},
      enabledBeforeClick,
      beforeApply,
      afterApply: {
        applyCalls: [...window.__localScribeSettingsHarness.applyCalls],
        patchCalls: [...window.__localScribeSettingsHarness.patchCalls],
        persisted: window.__localScribeSettingsHarness.persisted(),
        checked: selectionInputs.filter((input) => input.checked).map((input) => input.value),
        summary: document.querySelector(".ls-model-apply-card")?.textContent ?? "",
        feedback: document.querySelector(".ls-model-feedback")?.textContent ?? "",
        applyDisabled: apply.disabled,
      },
    };
  })()\`);
}

async function inspectSize(width, height, platform, verification, settingsPreset = "default", applyResult = null) {
  const window = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    frame: false,
    show: false,
    // The renderer uses the same isolation posture as the product window.
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    stage(\`render-process-gone reason=\${details.reason} exit=\${details.exitCode}\`);
  });
  window.webContents.on("destroyed", () => stage("web-contents-destroyed"));
  window.on("closed", () => stage("browser-window-closed"));
  window.webContents.on("console-message", (_event, level, message, line, source) => {
    stage(\`console level=\${level} line=\${line} source=\${source} message=\${message}\`);
  });
  window.webContents.on("did-start-loading", () => stage("did-start-loading"));
  window.webContents.on("did-finish-load", () => stage("did-finish-load"));
  window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    stage(\`did-fail-load code=\${code} description=\${description} main=\${isMainFrame} url=\${url}\`);
  });
  try {
    // Electron 43 on this macOS runner resolves did-finish-load and then
    // rejects loadURL with ERR_FAILED. The renderer is nevertheless live, so
    // use Chromium's finish event as the authoritative readiness signal.
    const didFinishLoad = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for the settings harness renderer")), 5_000);
      window.webContents.once("did-finish-load", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    const harnessUrl = new URL("localscribe-layout-test://settings/");
    harnessUrl.searchParams.set("platform", platform);
    harnessUrl.searchParams.set("verification", verification);
    harnessUrl.searchParams.set("settings", settingsPreset);
    if (applyResult) harnessUrl.searchParams.set("apply", applyResult);
    void window.loadURL(harnessUrl.href).catch((error) => {
      stage(\`loadURL-rejected \${error instanceof Error ? error.message : String(error)}\`);
    });
    await didFinishLoad;
    stage("harness-finish-load-observed");
    await sleep(100);
    const contentSize = await window.webContents.executeJavaScript(\`({ width: window.innerWidth, height: window.innerHeight })\`);
    const tabs = [
      await inspectTab(window, "General", platform === "win32" ? "Input access" : "Accessibility"),
      await inspectTab(window, "System", "History retention"),
      await inspectTab(
        window,
        "Model & Performance",
        platform === "win32"
          ? ".localscribe-model-install-deadbeefdeadbeefdeadbeefdeadbeef"
          : "Additional model families appear here only after their complete High, Medium, and Low profiles have pinned manifests and package validation for this local runtime.",
      ),
      await inspectTab(
        window,
        "Writing",
        settingsPreset === "custom"
          ? platform === "win32" ? "Notepad" : "TextEdit"
          : "No app profiles",
      ),
      await inspectTab(window, "Data & Privacy", "Automatic paste reads the active app identity and hashes limited focused-window metadata to confirm the dictation target. LocalScribe does not read field or document contents from other applications."),
    ];
    const saveReload = settingsPreset === "custom"
      ? await exerciseChangedSettings(window)
      : null;
    const modelSelection = applyResult ? await exerciseModelSelection(window, applyResult) : null;
    return {
      platform,
      verification,
      settingsPreset,
      applyResult,
      requestedSize: { width, height },
      contentSize,
      tabs,
      saveReload,
      modelSelection,
    };
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

async function run() {
  try {
  stage("app-ready");
  await session.defaultSession.setProxy({ mode: "direct" });
  stage("proxy-direct");
  protocol.handle("localscribe-layout-test", () => {
    stage("protocol-request");
    try {
      return new Response(readFileSync(harnessFile), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (error) {
      stage(\`protocol-error \${error instanceof Error ? error.stack : String(error)}\`);
      throw error;
    }
  });
  stage("protocol-ready");
  const sizes = ${JSON.stringify(settingsWindowSizes)};
  const results = [];
  for (const [width, height] of sizes) {
    results.push(await inspectSize(width, height, "darwin", "missing"));
  }
  for (const verification of ["missing", "invalid", "verified"]) {
    for (const [width, height] of sizes) {
      results.push(await inspectSize(width, height, "win32", verification));
    }
  }
  for (const platform of ["darwin", "win32"]) {
    for (const [width, height] of sizes) {
      results.push(await inspectSize(width, height, platform, "missing", "custom"));
    }
  }
  results.push(await inspectSize(900, 640, "darwin", "verified", "default", "success"));
  results.push(await inspectSize(900, 640, "darwin", "verified", "default", "fail"));
  writeFileSync(resultFile, JSON.stringify({ results }, null, 2));
  allowQuit = true;
  app.quit();
  } catch (error) {
    const detail = error instanceof Error ? error.stack : String(error);
    writeFileSync(resultFile, JSON.stringify({ error: \`\${detail}\\n\${readFileSync(stageFile, "utf8")}\` }, null, 2));
    app.exit(1);
  }
}

// Do not use top-level await here. Electron cannot signal app readiness until
// its main module has finished evaluating.
void app.whenReady().then(run).catch((error) => {
  const detail = error instanceof Error ? error.stack : String(error);
  writeFileSync(resultFile, JSON.stringify({ error: \`\${detail}\\n\${readFileSync(stageFile, "utf8")}\` }, null, 2));
  app.exit(1);
});
`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertTab(result, size) {
  const { label, before, after } = result;
  assert(before.clientHeight > 0, `${label}: content viewport has no height`);
  assert(before.scrollHeight >= before.clientHeight, `${label}: invalid scroll dimensions`);
  assert(Math.abs(after.headerTop - before.headerTop) <= 1, `${label}: header moved while content scrolled`);
  assert(Math.abs(after.footerTop - before.footerTop) <= 1, `${label}: footer moved while content scrolled`);
  assert(Math.abs(after.scrollTop - after.maxScrollTop) <= 1, `${label}: scrollTop did not reach its maximum`);
  const layoutEvidence = JSON.stringify({
    platform: size.platform,
    verification: size.verification,
    before,
    after,
    footerControls: result.footerControls,
    modelControls: result.modelControls,
  });
  assert(after.targetTop >= after.viewportTop - 1, `${label}: bottom target remains above the scroll viewport: ${layoutEvidence}`);
  assert(after.targetBottom <= after.viewportBottom + 1, `${label}: bottom target remains hidden behind the footer: ${layoutEvidence}`);
  assert(
    result.footerControls.map((control) => control.label).join("\u0000")
      === (label === "Model & Performance" ? "Cancel" : "Cancel\u0000Save changes"),
    `${label}: settings footer controls are incomplete: ${layoutEvidence}`,
  );
  assert(
    result.footerControls.every((control) => control.visible),
    `${label}: a settings footer control is clipped: ${layoutEvidence}`,
  );
  if (label === "Model & Performance") {
    assert(
      result.modelControls.modes.map((mode) => mode.value).join("\u0000") === "auto\u0000high\u0000medium\u0000low",
      `Model & Performance: expected Auto, High, Medium, and Low controls: ${layoutEvidence}`,
    );
    assert(
      result.modelControls.modes.every((control) => control.visible),
      `Model & Performance: a performance mode cannot be scrolled into view: ${layoutEvidence}`,
    );
    assert(
      result.modelControls.modes.filter((control) => control.checked).map((control) => control.value).join("")
        === (size.settingsPreset === "custom" ? "low" : "auto"),
      `Model & Performance: selected mode does not match persisted settings: ${layoutEvidence}`,
    );
    if (size.platform === "win32") {
      const expectedAction = {
        missing: "Download High profile for whisper-large-v3",
        invalid: "Repair High profile for whisper-large-v3",
        verified: "Remove High profile for whisper-large-v3",
      }[size.verification];
      assert(
        result.modelControls.actions.length === 1
        && result.modelControls.actions[0]?.label === expectedAction
        && result.modelControls.actions[0]?.visible,
        `Model & Performance: Windows shared artifact action is not truthful and reachable: ${layoutEvidence}`,
      );
      const copy = result.modelControls.copy;
      for (const expected of [
        "NVIDIA GeForce RTX 3060 Laptop GPU",
        "NVIDIA VRAM",
        "Catalog backend: faster-whisper/CTranslate2",
        "FP16",
        "INT8 weights + FP16 compute",
        "INT8",
        "legacy-qwen3-asr",
        "Unmanaged model data",
        ".localscribe-model-install-deadbeefdeadbeefdeadbeefdeadbeef",
        "Interrupted model installation",
        "will not be deleted automatically",
      ]) {
        assert(copy.includes(expected), `Model & Performance: Windows copy is missing "${expected}": ${layoutEvidence}`);
      }
      assert(
        result.modelControls.sharedLabels === 2,
        `Model & Performance: Windows shared profile labels are incomplete: ${layoutEvidence}`,
      );
    } else {
      assert(
        result.modelControls.actions.length === (size.applyResult ? 6 : 3)
        && result.modelControls.actions.every((control) => control.visible),
        `Model & Performance: a macOS install control cannot be scrolled into view: ${layoutEvidence}`,
      );
    }
  }
}

function assertModelSelection(size) {
  const evidence = size.modelSelection;
  if (!evidence) return;
  const serialized = JSON.stringify(evidence);
  assert(evidence.enabledBeforeClick, `Model Apply: expected verified selection to be applicable: ${serialized}`);
  assert(evidence.beforeApply.applyCalls.length === 0, `Model Apply: selection invoked IPC before Apply: ${serialized}`);
  assert(evidence.beforeApply.patchCalls.length === 0, `Model Apply: selection leaked into generic settings patch: ${serialized}`);
  assert(evidence.beforeApply.summary.includes("Currently using"), `Model Apply: current summary missing: ${serialized}`);
  assert(evidence.beforeApply.summary.includes("After applying"), `Model Apply: pending summary missing: ${serialized}`);
  assert(evidence.afterApply.applyCalls.length === 1, `Model Apply: expected exactly one combined call: ${serialized}`);
  assert(
    JSON.stringify(evidence.afterApply.applyCalls[0])
      === JSON.stringify({ familyId: "qwen3-asr-1-7b", performanceMode: "low" }),
    `Model Apply: request did not combine family and mode: ${serialized}`,
  );
  assert(evidence.afterApply.patchCalls.length === 0, `Model Apply: Apply used generic settings patch: ${serialized}`);
  if (evidence.expectedResult === "success") {
    assert(evidence.afterApply.persisted.modelPerformanceMode === "low", `Model Apply: acknowledged mode did not persist: ${serialized}`);
    assert(evidence.afterApply.persisted.activeModelFamilyId === "qwen3-asr-1-7b", `Model Apply: acknowledged family did not persist: ${serialized}`);
    assert(evidence.afterApply.applyDisabled, `Model Apply: unchanged acknowledged selection remained enabled: ${serialized}`);
    assert(evidence.afterApply.summary.includes("Current model selection"), `Model Apply: success did not converge current and pending: ${serialized}`);
  } else {
    assert(evidence.afterApply.persisted.modelPerformanceMode === "auto", `Model Apply: failed mode mutated persisted settings: ${serialized}`);
    assert(evidence.afterApply.persisted.activeModelFamilyId === "whisper-large-v3", `Model Apply: failed family mutated persisted settings: ${serialized}`);
    assert(evidence.afterApply.checked.join("") === "low", `Model Apply: failed selection was not preserved: ${serialized}`);
    assert(!evidence.afterApply.applyDisabled, `Model Apply: failed pending selection cannot be retried: ${serialized}`);
    assert(evidence.afterApply.feedback.includes("prior model selection remains active"), `Model Apply: failure copy is misleading: ${serialized}`);
  }
}

function assertChangedSettings(size) {
  if (size.settingsPreset !== "custom") return;
  const byLabel = Object.fromEntries(size.tabs.map((tab) => [tab.label, tab]));
  const general = byLabel.General?.settingsBindings;
  const system = byLabel.System?.settingsBindings;
  const writing = byLabel.Writing?.settingsBindings;
  const evidence = JSON.stringify({ platform: size.platform, general, system, writing, saveReload: size.saveReload });

  assert(general?.microphone?.value === "disconnected-usb-microphone", `Saved microphone ID is not bound: ${evidence}`);
  assert(
    general?.microphone?.selectedLabel === "Previously selected microphone (unavailable)",
    `Unavailable saved microphone is rendered blank or mislabeled: ${evidence}`,
  );
  assert(general?.language?.value === "Italian", `Saved language is not selected: ${evidence}`);
  assert(
    general?.language?.selectedLabel === "Italian (saved; not offered in this build)",
    `Older saved language is rendered blank or misleadingly: ${evidence}`,
  );
  const expectedHold = size.platform === "win32" ? "Alt + F13" : "Option + F13";
  const expectedToggle = size.platform === "win32" ? "Control + F14" : "Command + F14";
  assert(general?.holdShortcut?.includes(expectedHold), `Saved hold shortcut is not platform-formatted: ${evidence}`);
  assert(general?.toggleShortcut?.includes(expectedToggle), `Saved toggle shortcut is not platform-formatted: ${evidence}`);

  assert(system?.["Launch at login"]?.checked === false, `Launch-at-login control ignored the operating system's effective state: ${evidence}`);
  assert(
    system?.["Launch at login"]?.detail?.includes(
      size.platform === "darwin" ? "macOS requires approval" : "disabled in the operating system",
    ),
    `Launch-at-login mismatch has no actionable platform-specific explanation: ${evidence}`,
  );
  assert(system?.["Show floating bar"]?.checked === false, `Floating-bar setting is not bound: ${evidence}`);
  assert(system?.["Paste automatically"]?.checked === false, `Automatic-paste setting is not bound: ${evidence}`);
  assert(system?.["Save transcript history"]?.checked === false, `History setting is not bound: ${evidence}`);
  assert(system?.["History retention"]?.value === "90", `Retention setting is not bound: ${evidence}`);

  assert(writing?.["Remove filler words"]?.checked === false, `Filler setting is not bound: ${evidence}`);
  assert(writing?.["Spoken commands"]?.checked === true, `Spoken-command setting is not bound: ${evidence}`);
  assert(writing?.["Smart punctuation"]?.checked === false, `Punctuation setting is not bound: ${evidence}`);
  assert(
    writing?.copy?.includes(size.platform === "win32" ? "notepad.exe" : "com.apple.TextEdit"),
    `Persisted app profile is not rendered for the runtime platform: ${evidence}`,
  );

  const patchCalls = size.saveReload?.beforeReload?.patchCalls;
  assert(Array.isArray(patchCalls) && patchCalls.length === 1, `Settings save did not issue exactly one field patch: ${evidence}`);
  assert(
    JSON.stringify(patchCalls[0]) === JSON.stringify({
      language: "German",
      launchAtLogin: true,
      showPillWhenIdle: true,
      autoPaste: true,
      historyRetentionDays: 7,
    }),
    `Settings save submitted stale or unrelated fields: ${evidence}`,
  );
  assert(size.saveReload?.beforeReload?.status === "Settings saved", `Successful save was not acknowledged: ${evidence}`);
  assert(size.saveReload?.afterReload?.launchAtLogin === true, `Effective launch-at-login state did not survive reload: ${evidence}`);
  assert(size.saveReload?.afterReload?.language === "German", `Language did not survive reload: ${evidence}`);
  assert(size.saveReload?.afterReload?.showPillWhenIdle === true, `Floating-bar setting did not survive reload: ${evidence}`);
  assert(size.saveReload?.afterReload?.autoPaste === true, `Automatic-paste setting did not survive reload: ${evidence}`);
  assert(size.saveReload?.afterReload?.historyRetentionDays === "7", `Retention did not survive reload: ${evidence}`);
}

async function inlineHarnessHtml(directory) {
  const harnessOutput = resolve(directory, "scripts/settings-layout-harness.html");
  const html = await readFile(harnessOutput, "utf8");
  const scriptReference = html.match(/src="\.\.\/(assets\/[^"]+\.js)"/)?.[1];
  const styleReference = html.match(/href="\.\.\/(assets\/[^"]+\.css)"/)?.[1];
  if (!scriptReference || !styleReference) {
    throw new Error("Vite output did not contain the Settings harness script and stylesheet references.");
  }
  const [script, style] = await Promise.all([
    readFile(resolve(directory, scriptReference), "utf8"),
    readFile(resolve(directory, styleReference), "utf8"),
  ]);
  const inlineHtml = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><style>${style}</style></head><body><div id="root"></div><script type="module">${script}</script></body></html>`;
  return inlineHtml;
}

try {
  await build({
    root: repository,
    configFile: false,
    plugins: [react()],
    base: "./",
    build: {
      outDir: renderedDirectory,
      emptyOutDir: true,
      rollupOptions: { input: rendererSource },
    },
  });
  await writeFile(electronMainFile, electronMain, "utf8");
  await writeFile(resolve(temporaryRoot, "package.json"), JSON.stringify({
    name: "localscribe-settings-layout-harness",
    private: true,
    type: "module",
    main: "electron-main.mjs",
  }), "utf8");
  await writeFile(inlineHarnessFile, await inlineHarnessHtml(renderedDirectory), "utf8");
  const childEnvironment = {
      ...process.env,
      LOCALSCRIBE_SCROLL_HARNESS_FILE: inlineHarnessFile,
      LOCALSCRIBE_SCROLL_RESULT_FILE: resultFile,
  };
  // Electron treats any non-empty value as true. Passing `undefined` to
  // spawn would stringify it, so remove the variable rather than assigning it.
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [temporaryRoot], {
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const exitCode = await new Promise((resolveChild, rejectChild) => {
    child.once("error", rejectChild);
    child.once("close", resolveChild);
  });
  const report = JSON.parse(await readFile(resultFile, "utf8"));
  if (exitCode !== 0 || report.error) {
    throw new Error(`Electron harness failed: ${report.error ?? stderr}`);
  }
  for (const size of report.results) {
    assert(size.contentSize.width === size.requestedSize.width, "Electron width differs from requested content width");
    assert(size.contentSize.height === size.requestedSize.height, "Electron height differs from requested content height");
    for (const tab of size.tabs) assertTab(tab, size);
    assertChangedSettings(size);
    assertModelSelection(size);
  }
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const stage = await readFile(`${resultFile}.stage`, "utf8").catch(() => "(no Electron stage log was written)");
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}\nElectron stage log:\n${stage}`,
    { cause: error },
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
