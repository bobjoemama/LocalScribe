/* global window, document, MutationObserver, KeyboardEvent, InputEvent */
function domMilestone(predicate) {
  return new Promise((resolve, reject) => {
    let timer;
    const observer = new MutationObserver(check);
    function check() {
      if (!predicate()) return;
      observer.disconnect(); clearTimeout(timer); resolve();
    }
    observer.observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true });
    timer = setTimeout(() => { observer.disconnect(); reject(new Error('Preparation UI milestone timed out: ' + predicate.toString())); }, 4000);
    check();
  });
}
const evaluate = (window, fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(${args.map(value => JSON.stringify(value)).join(',')})`);
const wait = (window, predicate) => window.webContents.executeJavaScript(`(${domMilestone.toString()})(${predicate.toString()})`);
function blockedInput() {
  const keyboard = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  const beforeinput = new InputEvent('beforeinput', { inputType: 'insertText', data: 'Blocked fixture input', bubbles: true, cancelable: true });
  if (document.body.dispatchEvent(keyboard) || document.body.dispatchEvent(beforeinput)) throw new Error('Update preparation did not block keyboard/input events');
}

export async function inspectSettingsPreparation(appWindow) {
  await evaluate(appWindow, () => window.__localScribeSettingsHarness.showWorkspace());
  await wait(appWindow, () => Boolean(document.querySelector('.hub-sidebar__bottom button')));
  await evaluate(appWindow, () => document.querySelector('.hub-sidebar__bottom button').click());
  await wait(appWindow, () => Boolean(document.querySelector('.ls-settings-scroll .ls-settings-row')));
  await evaluate(appWindow, () => [...document.querySelectorAll('.ls-settings-sidebar nav button')].find(button => button.textContent.trim() === 'System').click());
  await wait(appWindow, () => [...document.querySelectorAll('.ls-settings-row')].some(row => row.querySelector('strong')?.textContent === 'Appearance'));
  const draft = await evaluate(appWindow, () => {
    const harness = window.__localScribeSettingsHarness;
    const original = harness.persisted().appearance;
    const value = original === 'dark' ? 'light' : 'dark';
    const select = [...document.querySelectorAll('.ls-settings-row')].find(row => row.querySelector('strong')?.textContent === 'Appearance').querySelector('select');
    select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }));
    return { original, value, writes: harness.patchCalls.length };
  });
  await wait(appWindow, () => !document.querySelector('.ls-settings-footer .ls-primary-button').disabled);
  const veto = await evaluate(appWindow, async () => {
    const harness = window.__localScribeSettingsHarness;
    harness.setConfirmAnswer(false);
    const prepared = await harness.prepareUpdate('settings-veto');
    if (prepared || document.querySelector('.hub-shell').inert) throw new Error('Rejected dirty Settings confirmation did not veto/unfreeze');
    return true;
  });
  await evaluate(appWindow, async () => {
    const harness = window.__localScribeSettingsHarness;
    harness.setConfirmAnswer(true);
    if (!await harness.prepareUpdate('settings-approved') || !document.querySelector('.hub-shell').inert) throw new Error('Approved Settings preparation did not freeze/acknowledge');
  });
  await evaluate(appWindow, blockedInput);
  const recovered = await evaluate(appWindow, (draft) => {
    const harness = window.__localScribeSettingsHarness;
    harness.cancelUpdate('settings-approved');
    const select = [...document.querySelectorAll('.ls-settings-row')].find(row => row.querySelector('strong')?.textContent === 'Appearance').querySelector('select');
    if (document.querySelector('.hub-shell').inert || select.value !== draft.value || harness.persisted().appearance !== draft.original || harness.patchCalls.length !== draft.writes) throw new Error('Cancelled preparation lost/saved dirty Settings');
    return true;
  }, draft);
  return { rejectedDraftVeto: veto, approvedFrozen: true, keyboardBlocked: true, cancelledDraftPreserved: recovered };
}

export async function inspectNotesPreparation(appWindow, capturePending = null) {
  await wait(appWindow, () => Boolean(document.querySelector('textarea:not(:disabled)')) && document.querySelector('.scratchpad-window__save-state')?.textContent.trim() === 'Saved');
  appWindow.webContents.debugger.attach('1.3');
  await appWindow.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  try {
    const edit = async (body) => {
      await evaluate(appWindow, () => { const input = document.querySelector('textarea'); input.focus(); input.select(); });
      await appWindow.webContents.insertText(body);
      await wait(appWindow, () => document.querySelector('.scratchpad-window__save-state')?.textContent.trim() === 'Saving');
    };
    await evaluate(appWindow, () => window.__localScribeNotesHarness.holdSave());
    await edit('Fixture durable text before update');
    await evaluate(appWindow, async () => {
      const harness = window.__localScribeSettingsHarness;
      window.__notePreparationSettled = false;
      window.__notePreparation = harness.prepareUpdate('notes-drain').then(result => { window.__notePreparationSettled = true; return result; });
      if (!document.querySelector('main[aria-label="Notes"]').inert) throw new Error('Notes did not freeze synchronously');
      await window.__localScribeNotesHarness.saveStarted();
      if (window.__notePreparationSettled) throw new Error('Notes acknowledged before deferred durable save');
    });
    if (capturePending) await capturePending();
    await evaluate(appWindow, blockedInput);
    await appWindow.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: 'x' });
    await evaluate(appWindow, async () => {
      if (document.querySelector('textarea').value !== 'Fixture durable text before update') throw new Error('Frozen Notes accepted keyboard editing');
      window.__localScribeNotesHarness.releaseSave();
      if (!await window.__notePreparation) throw new Error('Durable Notes drain did not acknowledge');
      if (window.__localScribeNotesHarness.persisted()[0].body !== 'Fixture durable text before update') throw new Error('Notes ack did not reflect persisted text');
      window.__localScribeSettingsHarness.cancelUpdate('notes-drain');
      if (document.querySelector('main[aria-label="Notes"]').inert) throw new Error('Cancelled Notes preparation remained frozen');
    });
    await wait(appWindow, () => document.querySelector('.scratchpad-window__save-state')?.textContent.trim() === 'Saved');
    await evaluate(appWindow, () => window.__localScribeNotesHarness.holdSave());
    await edit('Fixture unsaved draft after failed save');
    await evaluate(appWindow, async () => {
      window.__notePreparation = window.__localScribeSettingsHarness.prepareUpdate('notes-failure');
      await window.__localScribeNotesHarness.saveStarted();
      window.__localScribeNotesHarness.rejectSave();
      if (await window.__notePreparation) throw new Error('Failed Notes save acknowledged update');
      if (document.querySelector('main[aria-label="Notes"]').inert || document.querySelector('textarea').value !== 'Fixture unsaved draft after failed save') throw new Error('Failed save lost Notes draft or remained frozen');
      if (window.__localScribeNotesHarness.persisted()[0].body !== 'Fixture durable text before update') throw new Error('Failed save modified durable note: ' + JSON.stringify({ persisted: window.__localScribeNotesHarness.persisted(), writes: window.__localScribeNotesHarness.writes }));
    });
    await wait(appWindow, () => Boolean(document.querySelector('.scratchpad-window__save-state--error')));
    await evaluate(appWindow, () => document.querySelector('.scratchpad-window__save-state--error').click());
    await wait(appWindow, () => document.querySelector('.scratchpad-window__save-state')?.textContent.trim() === 'Saved');
    return await evaluate(appWindow, () => {
      if (window.__localScribeNotesHarness.persisted()[0].body !== 'Fixture unsaved draft after failed save') throw new Error('Notes save retry did not persist retained draft');
      return { synchronousFreeze: true, pendingSaveBlocksAck: true, durableSaveAck: true, keyboardBlocked: true, saveFailureVeto: true, draftRetained: true, unfreezesOnFailure: true, retryPersists: true };
    });
  } finally {
    await appWindow.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false });
    appWindow.webContents.debugger.detach();
  }
}
