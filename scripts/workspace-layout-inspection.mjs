/* global document, HTMLElement, getComputedStyle, requestAnimationFrame, window */
/** Real workspace checks in the existing isolated renderer fixture. No product
 * processes, user records, system clipboard or model operations are involved. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export async function inspectWorkspace(appWindow, options) {
  // Chromium excludes :focus styles from an inactive hidden page. CDP emulates
  // page focus for this fixture without showing or activating its native window.
  // https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setFocusEmulationEnabled
  appWindow.webContents.debugger.attach("1.3");
  try {
    await appWindow.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    if (appWindow.isVisible()) throw new Error("Workspace fixture became visible");
    return await inspectFocusedWorkspace(appWindow, options);
  } finally {
    if (!appWindow.isDestroyed()) {
      await appWindow.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: false });
      appWindow.webContents.debugger.detach();
    }
  }
}

async function inspectFocusedWorkspace(appWindow, { screenshotDirectory, appearance, width, height }) {
  const evaluate = (fn, ...args) => appWindow.webContents.executeJavaScript(`(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(",")})`);
  const wait = () => evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150)))));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const capture = async (name) => {
    if (!screenshotDirectory) return;
    const shot = await appWindow.webContents.capturePage();
    writeFileSync(join(screenshotDirectory, `workspace-${appearance}-${width}x${height}-${name}.png`), shot.toPNG());
  };
  const key = async (keyCode, modifiers = []) => {
    appWindow.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    appWindow.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await wait();
  };
  const click = async (selector) => {
    const point = await evaluate((selector) => {
      const bounds = document.querySelector(selector).getBoundingClientRect();
      return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
    }, selector);
    appWindow.webContents.sendInputEvent({ type: "mouseMove", ...point });
    appWindow.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
    appWindow.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
    await wait();
  };
  const selectPage = async (name) => {
    await evaluate(name => [...document.querySelectorAll(".hub-navigation button")].find(button => button.textContent.trim() === name).click(), name);
    await wait();
  };
  const fill = async (selector, text) => {
    await click(selector);
    // Hidden fixtures do not receive macOS menu accelerators. Select the field
    // range, then use Chromium's editing path so React receives a real input.
    await evaluate(selector => {
      const field = document.querySelector(selector);
      field.setSelectionRange(0, field.value.length);
    }, selector);
    appWindow.webContents.insertText(text);
    await wait();
  };
  await evaluate(() => window.__localScribeSettingsHarness.showWorkspace());
  await wait();
  await wait();
  const evidence = { menus: [], pages: [], reading: null };
  const modelBefore = await evaluate(() => ({ label: document.querySelector(".hi-dictation-status").textContent, settings: window.__localScribeSettingsHarness.persisted(), writes: window.__localScribeSettingsHarness.patchCalls.length, applies: window.__localScribeSettingsHarness.applyCalls.length }));
  assert(!modelBefore.label.includes("Loading") && !modelBefore.label.includes("unavailable"), "Saved model choice did not load");
  await click(".hi-dictation-status button:not(.hi-shortcut-edit)");
  const modelNavigation = await evaluate(() => ({
    title: document.querySelector(".ls-settings-header h1")?.textContent,
    tab: document.querySelector(".ls-settings-sidebar nav button.is-active")?.textContent.trim(),
    settings: window.__localScribeSettingsHarness.persisted(),
    writes: window.__localScribeSettingsHarness.patchCalls.length,
    applies: window.__localScribeSettingsHarness.applyCalls.length,
  }));
  assert(modelNavigation.title === "Models" && !modelNavigation.tab, "Choose model did not open the model workspace");
  assert(modelBefore.writes === modelNavigation.writes && modelBefore.applies === modelNavigation.applies && JSON.stringify(modelBefore.settings) === JSON.stringify(modelNavigation.settings), "Choose model unexpectedly changed saved selection or applied a model");
  await capture("choose-model-settings");
  await selectPage("Dictation");
  assert(await evaluate(() => !!document.querySelector(".hi-dictation-status button:not(.hi-shortcut-edit)") && !document.querySelector(".ls-settings-modal")), "Returning from Models did not restore Dictation workspace");
  evidence.modelChoice = { before: modelBefore, navigation: modelNavigation, returnsToDictation: true };
  for (const page of ["Dictation", "Insights", "Dictionary", "Snippets", "Cleanup", "Models"]) {
    await selectPage(page);
    await capture(page.toLowerCase());
    const pageState = await evaluate(() => {
      const host = document.querySelector(".hub-content");
      const active = document.querySelector(".hub-nav-item--active");
      const luminance = value => {
        const channels = value.match(/[0-9.]+/g).slice(0, 3).map(Number).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
        return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
      };
      const samples = [...document.querySelectorAll(".hub-nav-item--active, .hub-version, .hi-welcome h1, .hi-welcome p, .hi-dictation-status span, .hi-dictation-status strong, .hi-dictation-status button:not(.hi-shortcut-edit), .hi-transcript-text, .hi-transcript-meta, .hi-time strong, .hi-section-title h2, .ln-page__topbar h1, .ln-page__topbar p, .ln-row__actions button, .ls-screen-header h1, .ls-screen-header p")].map(node => {
        let ancestor = node;
        while (ancestor && getComputedStyle(ancestor).backgroundColor === "rgba(0, 0, 0, 0)") ancestor = ancestor.parentElement;
        const foreground = getComputedStyle(node).color;
        const background = getComputedStyle(ancestor).backgroundColor;
        const a = luminance(foreground), b = luminance(background);
        return { selector: node.className || node.tagName, foreground, background, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
      });
      return { horizontalOverflow: host.scrollWidth - host.clientWidth, activeLabel: active.textContent.trim(), activeForeground: getComputedStyle(active).color, activeBackground: getComputedStyle(active).backgroundColor, samples };
    });
    assert(pageState.horizontalOverflow <= 1, `${page}: horizontal overflow ${JSON.stringify(pageState)}`);
    assert(pageState.activeLabel === page, `${page}: selection state missing`);
    assert(pageState.samples.every(sample => sample.contrast >= 4.5), `${page}: rendered essential text below 4.5: ${JSON.stringify(pageState)}`);
    evidence.pages.push({ page, ...pageState });
  }
  await selectPage("Models");
  await evaluate(() => {
    window.__localScribeSettingsHarness.delayModelOperation();
    const download = document.querySelector('button[aria-label="Download High profile for qwen3-asr-0-6b"]');
    if (!download || download.disabled) throw new Error("Missing enabled fixture download action");
    download.click();
  });
  await wait();
  await evaluate(() => window.__localScribeSettingsHarness.sendModelProgress({ familyId: "qwen3-asr-0-6b", tier: "high", phase: "downloading", completedBytes: 500000000, totalBytes: 1000000000 }));
  await wait();
  await evaluate(() => document.querySelector('[aria-label="Downloading 0.50 GB of 1.00 GB (50%)"]').scrollIntoView({ block: "center" }));
  await capture("models-downloading");
  const activeDownload = await evaluate(() => ({ progress: document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"), blockedControls: [...document.querySelectorAll('.ls-model-tier-row button')].every(button => button.disabled) }));
  assert(activeDownload.progress === "50" && activeDownload.blockedControls, "Model download progress is invented or concurrent controls are active");
  await selectPage("Dictation");
  assert(await evaluate(() => document.querySelector('.hub-nav-item--active')?.textContent.trim() === "Models" && document.querySelector('.ls-model-feedback')?.textContent.includes("on its own")), "Navigation unmounted an active model download");
  await evaluate(() => [...document.querySelectorAll('.hub-sidebar__bottom button')].find(button => button.textContent.trim() === "Settings").click());
  await wait();
  assert(await evaluate(() => !document.querySelector('.ls-settings-modal')), "Settings opened while the guarded model operation was active");
  await evaluate(() => window.__localScribeSettingsHarness.finishModelOperation());
  await wait();
  await capture("models-download-complete");
  evidence.modelOperation = { activeDownload, navigationBlocked: true, settingsBlocked: true, completionVerified: await evaluate(() => [...document.querySelectorAll('.ls-model-tier-row')].some(row => row.textContent.includes("High") && row.textContent.includes("Verified"))) };
  assert(evidence.modelOperation.completionVerified, "Completed download did not refresh verification state");
  await selectPage("Dictation");
  evidence.reading = await evaluate(() => [...document.querySelectorAll(".hi-transcript-text")].map(input => ({ height: input.clientHeight, scrollHeight: input.scrollHeight, complete: input.value.length, readOnly: input.readOnly, fieldSizing: getComputedStyle(input).fieldSizing })));
  assert(evidence.reading.length === 3 && evidence.reading.every(input => input.readOnly), "Fixture transcript values are missing or editable");
  assert(evidence.reading[0].height < 72 && evidence.reading[1].height < 72, "Short transcripts still have a fixed empty viewport");
  assert(evidence.reading[2].height <= 176 && evidence.reading[2].scrollHeight > evidence.reading[2].height, "Long transcript is not bounded and scrollable");

  for (const kind of ["header", "row"]) {
    const selector = `.hi-overflow--${kind}`;
    await click(`${selector} > summary`);
    await capture(`dictation-${kind}-menu-open`);
    const menuState = await evaluate((selector) => {
      const details = document.querySelector(selector);
      const popup = details.querySelector(".hi-overflow-menu");
      const viewport = document.querySelector(".hub-content").getBoundingClientRect();
      const rect = popup.getBoundingClientRect();
      const probe = document.createElement("div");
      probe.style.backgroundColor = "var(--surface-raised)";
      details.append(probe);
      const expectedBackground = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const luminance = (value) => {
        const c = value.match(/[0-9.]+/g).slice(0,3).map(Number).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
        return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
      };
      const samples = [...popup.querySelectorAll("button:not(:disabled)")].map(button => {
        let ancestor = button;
        while (ancestor && getComputedStyle(ancestor).backgroundColor === "rgba(0, 0, 0, 0)") ancestor = ancestor.parentElement;
        const foreground = getComputedStyle(button).color;
        const background = getComputedStyle(ancestor).backgroundColor;
        const a = luminance(foreground), b = luminance(background);
        return { label: button.textContent.trim(), foreground, background, contrast: (Math.max(a,b) + .05) / (Math.min(a,b) + .05) };
      });
      return { open: details.open, background: getComputedStyle(popup).backgroundColor, expectedBackground, borderWidth: getComputedStyle(popup).borderTopWidth, outlineWidth: getComputedStyle(popup).outlineWidth, outlineStyle: getComputedStyle(popup).outlineStyle, bounds: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, viewport: { left: viewport.left, right: viewport.right, top: viewport.top, bottom: viewport.bottom }, samples };
    }, selector);
    assert(menuState.open && menuState.background === menuState.expectedBackground, `${kind}: popup does not share the adaptive elevated surface: ${JSON.stringify(menuState)}`);
    assert(menuState.borderWidth === "1px" && menuState.outlineStyle === "none", `${kind}: popup has a heavy border/outline: ${JSON.stringify(menuState)}`);
    assert(menuState.samples.every(sample => sample.contrast >= 4.5), `${kind}: text contrast below 4.5: ${JSON.stringify(menuState)}`);
    assert(menuState.bounds.left >= menuState.viewport.left && menuState.bounds.right <= menuState.viewport.right && menuState.bounds.top >= menuState.viewport.top && menuState.bounds.bottom <= menuState.viewport.bottom, `${kind}: popup is clipped: ${JSON.stringify(menuState)}`);
    await key("Down");
    const focus = await evaluate(selector => {
      const button = document.querySelector(`${selector} .hi-overflow-menu button`);
      return { firstItemFocused: document.activeElement === button, focusVisible: button.matches(":focus-visible"), outlineStyle: getComputedStyle(button).outlineStyle, outlineWidth: getComputedStyle(button).outlineWidth };
    }, selector);
    assert(focus.firstItemFocused && focus.focusVisible && focus.outlineStyle === "solid" && focus.outlineWidth === "2px", `${kind}: keyboard focus missing: ${JSON.stringify(focus)}`);
    await capture(`dictation-${kind}-menu-keyboard`);
    for (const [keyCode, expected] of [["End", "last"], ["Down", "first"], ["Up", "last"], ["Home", "first"]]) {
      await key(keyCode);
      assert(await evaluate((selector, expected) => {
        const buttons = [...document.querySelector(selector).querySelectorAll(".hi-overflow-menu button:not(:disabled)")];
        return document.activeElement === buttons[expected === "first" ? 0 : buttons.length - 1];
      }, selector, expected), `${kind}: ${keyCode} did not navigate actions`);
    }
    await key("Escape");
    const escape = await evaluate(selector => {
      const menu = document.querySelector(selector);
      return { closed: !menu.open, focusRestored: document.activeElement === menu.querySelector("summary"), outlineStyle: getComputedStyle(menu.querySelector("summary")).outlineStyle, outlineWidth: getComputedStyle(menu.querySelector("summary")).outlineWidth };
    }, selector);
    assert(escape.closed && escape.focusRestored && escape.outlineStyle === "solid" && escape.outlineWidth === "2px", `${kind}: Escape did not close and restore focus`);
    await click(`${selector} > summary`);
    await click(".hi-welcome h1");
    assert(await evaluate(selector => !document.querySelector(selector).open, selector), `${kind}: outside click did not close`);
    evidence.menus.push({ kind, ...menuState, focus, escape, outsideClickCloses: true });
  }
  // Native details grouping keeps only one actions popup open at a time.
  await click(".hi-overflow--header > summary");
  await click(".hi-overflow--row > summary");
  assert(await evaluate(() => document.querySelectorAll(".hi-overflow[open]").length === 1), "History opens more than one popup");
  await click(".hi-overflow--row .hi-overflow-menu button");
  const copied = await evaluate(() => ({ closed: !document.querySelector(".hi-overflow--row").open, focusRestored: document.activeElement === document.querySelector(".hi-overflow--row > summary"), writes: window.__localScribeSettingsHarness.clipboardWrites.length, notice: document.querySelector(".hi-success-toast, .hi-live-region")?.textContent ?? "" }));
  assert(copied.closed && copied.focusRestored && copied.writes === 1 && copied.notice.includes("Transcript copied."), "Copy action did not close and report success through the isolated clipboard stub");
  await capture("dictation-copy-feedback");
  evidence.copy = copied;
  await click('[aria-label="Search transcripts"]');
  await click(".hi-search input");
  appWindow.webContents.insertText("No fixture transcript matches this query");
  await wait();
  await click(".hi-overflow--header > summary");
  const search = await evaluate(() => ({
    empty: !!document.querySelector(".hi-empty-state"),
    matchingTranscripts: document.querySelectorAll(".hi-transcript-text").length,
    copyDisabled: document.querySelector(".hi-overflow--header .hi-overflow-menu button").disabled,
  }));
  assert(search.empty && search.matchingTranscripts === 0 && search.copyDisabled, "No-match search state or disabled copy is missing");
  await capture("dictation-search-no-matches");
  await click('[aria-label="Close transcript search"]');
  assert(await evaluate(() => document.querySelectorAll(".hi-transcript-text").length === 3), "Closing search did not restore complete history");
  evidence.search = search;

  await selectPage("Dictionary");
  await click(".ln-primary");
  await capture("dictionary-add-dialog");
  const dialog = await evaluate(() => {
    const modal = document.querySelector(".ln-modal");
    const page = document.querySelector(".ln-page-frame")?.parentElement;
    return { visible: modal instanceof HTMLElement, background: modal && getComputedStyle(modal).backgroundColor, modal: modal?.getAttribute("aria-modal"), pageInert: page?.inert };
  });
  assert(dialog.visible && dialog.modal === "true" && dialog.pageInert, "Dictionary editor dialog did not open");
  evidence.dictionaryDialog = dialog;
  await click(".ln-modal__close");
  assert(await evaluate(() => document.activeElement === document.querySelector(".ln-primary")), "Closing dictionary editor did not restore trigger focus");
  evidence.libraryEditors = [];
  for (const [page, kind, firstField, secondField] of [
    ["Dictionary", "dictionary", "phrase", "replacement"],
    ["Snippets", "snippets", "trigger", "expansion"],
  ]) {
    await selectPage(page);
    const before = await evaluate(kind => ({ entries: window.__localScribeSettingsHarness.library()[kind], attempts: window.__localScribeSettingsHarness.librarySaveCalls.length }), kind);
    const entry = before.entries[0];
    const first = ".ln-modal__form input";
    const second = kind === "dictionary" ? ".ln-modal__form label:nth-child(2) input" : ".ln-modal__form textarea";
    const draft = () => evaluate(() => ({ values: [...document.querySelectorAll(".ln-modal__form input, .ln-modal__form textarea")].map(node => node.value), saveDisabled: document.querySelector('.ln-modal__form button[type="submit"]').disabled }));
    await click(".ln-edit-button");
    const initial = await draft();
    assert(initial.values[0] === entry[firstField] && initial.values[1] === entry[secondField] && initial.saveDisabled, `${kind}: editor was not prefilled with unchanged Save disabled`);
    const dialogLayout = await evaluate(() => {
      const modal = document.querySelector(".ln-modal");
      const bounds = modal.getBoundingClientRect();
      const focusable = [...modal.querySelectorAll("button:not(:disabled), input, textarea")];
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: window.innerWidth, height: window.innerHeight, focused: modal.contains(document.activeElement), first: focusable[0].className, last: focusable.at(-1).className };
    });
    assert(dialogLayout.focused && dialogLayout.left >= 0 && dialogLayout.right <= dialogLayout.width && dialogLayout.top >= 0 && dialogLayout.bottom <= dialogLayout.height, `${kind}: editor is clipped or focus is outside: ${JSON.stringify(dialogLayout)}`);
    await evaluate(() => document.querySelector(".ln-modal button:not(:disabled)").focus());
    await key("Tab", ["shift"]);
    assert(await evaluate(() => {
      const controls = [...document.querySelectorAll(".ln-modal button:not(:disabled), .ln-modal input, .ln-modal textarea")];
      return document.activeElement === controls.at(-1);
    }), `${kind}: Shift-Tab escaped the editor`);
    await key("Tab");
    assert(await evaluate(() => document.activeElement === document.querySelector(".ln-modal button:not(:disabled)")), `${kind}: Tab escaped the editor`);
    await click(first);
    await capture(`${kind}-edit-dialog`);
    await fill(first, "Cancelled draft");
    await fill(second, "Cancelled content");
    await evaluate(() => window.__localScribeSettingsHarness.setConfirmAnswer(false));
    await click('.ln-modal__actions button[type="button"]');
    const retainedDraft = await draft();
    assert(retainedDraft.values[0] === "Cancelled draft" && retainedDraft.values[1] === "Cancelled content", `${kind}: rejecting discard lost the draft`);
    await evaluate(() => window.__localScribeSettingsHarness.setConfirmAnswer(true));
    await click('.ln-modal__actions button[type="button"]');
    const cancelled = await evaluate(kind => ({ entries: window.__localScribeSettingsHarness.library()[kind], attempts: window.__localScribeSettingsHarness.librarySaveCalls.length, focusRestored: document.activeElement === document.querySelector(".ln-edit-button") }), kind);
    assert(cancelled.attempts === before.attempts && JSON.stringify(cancelled.entries) === JSON.stringify(before.entries) && cancelled.focusRestored, `${kind}: Cancel wrote data or lost trigger focus`);
    await click(".ln-edit-button");
    const reopened = await draft();
    assert(reopened.values[0] === entry[firstField] && reopened.values[1] === entry[secondField], `${kind}: Cancel draft leaked into the next editor`);
    const changedFirst = entry[firstField] + " updated";
    const changedSecond = kind === "dictionary" ? "LocalScribe Desktop" : "\n  Regards,\n    Morgan\n";
    await fill(first, changedFirst);
    await fill(second, changedSecond);
    await evaluate(() => window.__localScribeSettingsHarness.failLibrarySave());
    await click('.ln-modal__form button[type="submit"]');
    const failed = await evaluate(kind => ({ message: document.querySelector(".ln-modal [role=alert]")?.textContent, entries: window.__localScribeSettingsHarness.library()[kind] }), kind);
    const failedDraft = await draft();
    assert(failed.message?.includes("already uses") && JSON.stringify(failed.entries) === JSON.stringify(before.entries) && failedDraft.values[0] === changedFirst && failedDraft.values[1] === changedSecond && !failedDraft.saveDisabled, `${kind}: failed save lost the draft or changed stored data: ${JSON.stringify({ failed, failedDraft, expected: { changedFirst, changedSecond } })}`);
    await capture(`${kind}-edit-error`);
    await fill(first, changedFirst + " retry");
    assert(await evaluate(() => !document.querySelector(".ln-modal [role=alert]")), `${kind}: obsolete validation message persisted after correcting the draft`);
    await fill(first, changedFirst);
    await evaluate(() => window.__localScribeSettingsHarness.delayLibrarySave());
    await click('.ln-modal__form button[type="submit"]');
    const pending = await evaluate(() => ({
      controlsDisabled: [...document.querySelectorAll(".ln-modal input, .ln-modal textarea, .ln-modal button")].every(control => control.disabled),
      saving: document.querySelector('.ln-modal button[type="submit"]')?.textContent,
    }));
    assert(pending.controlsDisabled && pending.saving === "Saving…", `${kind}: an in-flight save allowed draft changes or closing: ${JSON.stringify(pending)}`);
    await evaluate(() => window.__localScribeSettingsHarness.finishLibrarySave());
    await wait();
    const saved = await evaluate(kind => ({ visibleEditor: !!document.querySelector(".ln-modal"), entries: window.__localScribeSettingsHarness.library()[kind], lastCall: window.__localScribeSettingsHarness.librarySaveCalls.at(-1), overflow: document.querySelector(".hub-content").scrollWidth - document.querySelector(".hub-content").clientWidth }), kind);
    const result = saved.entries.find(candidate => candidate.id === entry.id);
    assert(!saved.visibleEditor && saved.entries.length === before.entries.length && result.createdAt === entry.createdAt && result[firstField] === changedFirst && result[secondField] === changedSecond && saved.lastCall.input.id === entry.id && saved.overflow <= 1, `${kind}: edited Save did not preserve identity, formatting or layout`);
    await capture(`${kind}-edited-list`);
    await click(".ln-page__topbar .ln-primary");
    const blank = await draft();
    assert(blank.values.every(value => value === "") && blank.saveDisabled, `${kind}: Add new reused the previous edit draft`);
    await click('.ln-modal__actions button[type="button"]');
    await fill(".ln-search input", "does not match the new entry");
    await click(".ln-page__topbar .ln-primary");
    const createdFirst = `fixture new ${kind}`;
    await fill(first, createdFirst);
    await fill(second, "New saved content");
    await click('.ln-modal__form button[type="submit"]');
    const created = await evaluate(kind => ({
      query: document.querySelector(".ln-search input").value,
      text: document.querySelector(".ln-list").textContent,
      entries: window.__localScribeSettingsHarness.library()[kind],
      editorOpen: !!document.querySelector(".ln-modal"),
    }), kind);
    assert(!created.editorOpen && created.query === "" && created.text.includes(createdFirst) && created.entries.length === before.entries.length + 1, `${kind}: successful create remained hidden behind the previous search`);
    evidence.libraryEditors.push({ kind, initial, dialogLayout, keyboardFocusTrapped: true, cancelNoWrites: true, failedDraftPreserved: true, saved, addDraftIsBlank: true, staleErrorCleared: true, busyDraftLocked: true, createdUnderSearchVisible: true });
  }
  await evaluate(() => window.__localScribeSettingsHarness.remount());
  await wait();
  return evidence;
}

export async function inspectSettingsAppearance(appWindow) {
  const evaluate = (fn) => appWindow.webContents.executeJavaScript(`(${fn.toString()})()`);
  const wait = () => evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150)))));
  const measure = () => evaluate(() => {
    const luminance = value => {
      const c = value.match(/[0-9.]+/g).slice(0,3).map(Number).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
      return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
    };
    const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
    const primary = document.querySelector(".ls-settings-footer .ls-primary-button");
    const style = getComputedStyle(primary);
    const controls = [...document.querySelectorAll(".ls-settings-row select, .ls-shortcut-recorder__button")].map(control => {
      const css = getComputedStyle(control);
      return { label: control.getAttribute("aria-label") ?? control.tagName, border: css.borderTopColor, background: css.backgroundColor, boundaryContrast: contrast(css.borderTopColor, css.backgroundColor) };
    });
    const bounds = primary.getBoundingClientRect();
    return { foreground: style.color, background: style.backgroundColor, textContrast: contrast(style.color, style.backgroundColor), controls, point: { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) }, patchCalls: window.__localScribeSettingsHarness.patchCalls.length };
  });
  await wait();
  const normal = await measure();
  appWindow.webContents.sendInputEvent({ type: "mouseMove", ...normal.point });
  await new Promise(resolve => setTimeout(resolve, 150));
  const hover = await measure();
  appWindow.webContents.sendInputEvent({ type: "mouseDown", ...normal.point, button: "left", clickCount: 1 });
  await new Promise(resolve => setTimeout(resolve, 150));
  const pressed = await measure();
  // Release outside the control to inspect :active without triggering Save.
  appWindow.webContents.sendInputEvent({ type: "mouseMove", x: 1, y: 1 });
  appWindow.webContents.sendInputEvent({ type: "mouseUp", x: 1, y: 1, button: "left", clickCount: 1 });
  await wait();
  const after = await measure();
  for (const state of [normal, hover, pressed]) {
    if (state.textContrast < 4.5) throw new Error(`Rendered primary action contrast below 4.5: ${JSON.stringify(state)}`);
    if (state.controls.some(control => control.boundaryContrast < 3)) throw new Error(`Rendered custom control boundary below 3: ${JSON.stringify(state)}`);
  }
  if (normal.background === hover.background || hover.background === pressed.background) throw new Error("Primary action lacks hover/press feedback");
  if (after.patchCalls !== normal.patchCalls) throw new Error("Appearance measurement unexpectedly saved settings");
  return { normal, hover, pressed };
}
