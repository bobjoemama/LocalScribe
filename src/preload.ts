import { contextBridge, ipcRenderer } from "electron";
import { z } from "zod";
import {
  appInfoSchema,
  appSettingsPatchSchema,
  appSettingsSchema,
  appProfileSchema,
  diagnosticsSchema,
  dictionaryEntrySchema,
  cancelLiveAudioSchema,
  finishLiveAudioSchema,
  IPC,
  liveAudioFrameSchema,
  liveAudioSessionSchema,
  launchAtLoginStatusSchema,
  modelInstallRequestSchema,
  modelCatalogSchema,
  modelFamilyLibraryRequestSchema,
  modelSelectionApplyRequestSchema,
  modelSelectionApplyResultSchema,
  modelRemoveRequestSchema,
  navigationTargetSchema,
  permissionSnapshotSchema,
  pillModeSchema,
  scratchpadNoteSchema,
  sessionSnapshotSchema,
  snippetSchema,
  transcribeAudioSchema,
  transcriptionSchema,
  type LocalScribeApi,
  type NavigationTarget,
} from "./shared/contracts";
import {
  shortcutUpdateRequestSchema,
  shortcutValidationRequestSchema,
  shortcutValidationResultSchema,
} from "./shared/shortcuts";

const api: LocalScribeApi = {
  session: {
    get: async () => sessionSnapshotSchema.parse(await ipcRenderer.invoke(IPC.sessionGet)),
    toggle: async () => sessionSnapshotSchema.parse(await ipcRenderer.invoke(IPC.sessionToggle)),
    cancel: async () => sessionSnapshotSchema.parse(await ipcRenderer.invoke(IPC.sessionCancel)),
    fail: async (message) =>
      sessionSnapshotSchema.parse(await ipcRenderer.invoke(IPC.sessionFail, message)),
    transcribe: async (request) => {
      transcribeAudioSchema.parse(request);
      return transcriptionSchema.parse(await ipcRenderer.invoke(IPC.sessionTranscribe, request));
    },
    beginLive: async (session) => {
      const input = liveAudioSessionSchema.parse(session);
      await ipcRenderer.invoke(IPC.sessionBeginLive, input);
    },
    pushLive: async (frame) => {
      const input = liveAudioFrameSchema.parse(frame);
      await ipcRenderer.invoke(IPC.sessionPushLive, input);
    },
    finishLive: async (request) => {
      const input = finishLiveAudioSchema.parse(request);
      return transcriptionSchema.parse(await ipcRenderer.invoke(IPC.sessionFinishLive, input));
    },
    cancelLive: async (request) => {
      const input = cancelLiveAudioSchema.parse(request);
      await ipcRenderer.invoke(IPC.sessionCancelLive, input);
    },
    onChanged: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) =>
        listener(sessionSnapshotSchema.parse(value));
      ipcRenderer.on(IPC.sessionChanged, wrapped);
      return () => ipcRenderer.removeListener(IPC.sessionChanged, wrapped);
    },
  },
  history: {
    list: async (limit) => transcriptionSchema.array().parse(await ipcRenderer.invoke(IPC.historyList, limit)),
    delete: async (id) => ipcRenderer.invoke(IPC.historyDelete, id),
    clear: async () => ipcRenderer.invoke(IPC.historyClear),
    export: async () => ipcRenderer.invoke(IPC.historyExport),
    onChanged: (listener) => {
      const wrapped = () => listener();
      ipcRenderer.on(IPC.historyChanged, wrapped);
      return () => ipcRenderer.removeListener(IPC.historyChanged, wrapped);
    },
  },
  dictionary: {
    list: async () => dictionaryEntrySchema.array().parse(await ipcRenderer.invoke(IPC.dictionaryList)),
    save: async (input) => dictionaryEntrySchema.parse(await ipcRenderer.invoke(IPC.dictionarySave, input)),
    delete: async (id) => ipcRenderer.invoke(IPC.dictionaryDelete, id),
  },
  snippets: {
    list: async () => snippetSchema.array().parse(await ipcRenderer.invoke(IPC.snippetsList)),
    save: async (input) => snippetSchema.parse(await ipcRenderer.invoke(IPC.snippetsSave, input)),
    delete: async (id) => ipcRenderer.invoke(IPC.snippetsDelete, id),
  },
  profiles: {
    list: async () => appProfileSchema.array().parse(await ipcRenderer.invoke(IPC.profilesList)),
    save: async (input) => appProfileSchema.parse(await ipcRenderer.invoke(IPC.profilesSave, input)),
    delete: async (id) => ipcRenderer.invoke(IPC.profilesDelete, id),
  },
  scratchpad: {
    list: async () => scratchpadNoteSchema.array().parse(await ipcRenderer.invoke(IPC.scratchpadList)),
    create: async () => scratchpadNoteSchema.parse(await ipcRenderer.invoke(IPC.scratchpadCreate)),
    update: async (id, body) =>
      scratchpadNoteSchema.parse(await ipcRenderer.invoke(IPC.scratchpadUpdate, id, body)),
    delete: async (id) => ipcRenderer.invoke(IPC.scratchpadDelete, id),
  },
  settings: {
    get: async () => appSettingsSchema.parse(await ipcRenderer.invoke(IPC.settingsGet)),
    patch: async (input) => {
      const patch = appSettingsPatchSchema.parse(input);
      return appSettingsSchema.parse(await ipcRenderer.invoke(IPC.settingsPatch, patch));
    },
    onChanged: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) =>
        listener(appSettingsSchema.parse(value));
      ipcRenderer.on(IPC.settingsChanged, wrapped);
      return () => ipcRenderer.removeListener(IPC.settingsChanged, wrapped);
    },
  },
  shortcuts: {
    beginCapture: async () => ipcRenderer.invoke(IPC.shortcutsBeginCapture),
    endCapture: async () => ipcRenderer.invoke(IPC.shortcutsEndCapture),
    validate: async (input) => {
      const request = shortcutValidationRequestSchema.parse(input);
      return shortcutValidationResultSchema.parse(await ipcRenderer.invoke(IPC.shortcutsValidate, request));
    },
    update: async (input) => {
      const request = shortcutUpdateRequestSchema.parse(input);
      return appSettingsSchema.parse(await ipcRenderer.invoke(IPC.shortcutsUpdate, request));
    },
  },
  windows: {
    showSettings: async (target) => ipcRenderer.invoke(
      IPC.windowShowSettings,
      target === undefined ? undefined : navigationTargetSchema.parse(target),
    ),
    setPillMode: async (mode) => ipcRenderer.invoke(IPC.windowSetPillMode, mode),
    closeScratchpad: async () => ipcRenderer.invoke(IPC.windowCloseScratchpad),
    toggleScratchpadSize: async () => ipcRenderer.invoke(IPC.windowToggleScratchpadSize),
    onNavigate: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, target: NavigationTarget) =>
        listener(navigationTargetSchema.parse(target));
      ipcRenderer.on(IPC.windowNavigate, wrapped);
      return () => ipcRenderer.removeListener(IPC.windowNavigate, wrapped);
    },
    onVisibilityChanged: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, visible: unknown) =>
        listener(z.boolean().parse(visible));
      ipcRenderer.on(IPC.windowVisibility, wrapped);
      return () => ipcRenderer.removeListener(IPC.windowVisibility, wrapped);
    },
    onPillModeChanged: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, mode: unknown) =>
        listener(pillModeSchema.parse(mode));
      ipcRenderer.on(IPC.windowPillMode, wrapped);
      return () => ipcRenderer.removeListener(IPC.windowPillMode, wrapped);
    },
  },
  system: {
    getPermissions: async () =>
      permissionSnapshotSchema.parse(await ipcRenderer.invoke(IPC.systemGetPermissions)),
    getLaunchAtLoginStatus: async () =>
      launchAtLoginStatusSchema.parse(await ipcRenderer.invoke(IPC.systemGetLaunchAtLoginStatus)),
    openPermission: async (kind) => ipcRenderer.invoke(IPC.systemOpenPermission, kind),
    appInfo: async () => appInfoSchema.parse(await ipcRenderer.invoke(IPC.systemAppInfo)),
    diagnostics: async () => diagnosticsSchema.parse(await ipcRenderer.invoke(IPC.systemDiagnostics)),
    diagnosticsLog: async () => z.string().parse(await ipcRenderer.invoke(IPC.systemDiagnosticsLog)),
    modelCatalog: async () => modelCatalogSchema.parse(await ipcRenderer.invoke(IPC.systemModelCatalog)),
    addModelFamily: async (request) => {
      const input = modelFamilyLibraryRequestSchema.parse(request);
      return modelCatalogSchema.parse(await ipcRenderer.invoke(IPC.systemAddModelFamily, input));
    },
    applyModelSelection: async (request) => {
      const input = modelSelectionApplyRequestSchema.parse(request);
      return modelSelectionApplyResultSchema.parse(
        await ipcRenderer.invoke(IPC.systemApplyModelSelection, input),
      );
    },
    installModel: async (request) => {
      const input = modelInstallRequestSchema.parse(request);
      return diagnosticsSchema.parse(await ipcRenderer.invoke(IPC.systemInstallModel, input));
    },
    removeModel: async (request) => {
      const input = modelRemoveRequestSchema.parse(request);
      return diagnosticsSchema.parse(await ipcRenderer.invoke(IPC.systemRemoveModel, input));
    },
  },
};

contextBridge.exposeInMainWorld("localScribe", api);
