import { IPC } from "../shared/contracts";
import type { RendererSurface } from "./rendererProtocol";

const PILL_CHANNELS = new Set<string>([
  IPC.sessionGet,
  IPC.sessionToggle,
  IPC.sessionCancel,
  IPC.sessionFail,
  IPC.sessionTranscribe,
  IPC.settingsGet,
  IPC.settingsPatch,
  IPC.windowShowSettings,
  IPC.windowSetPillMode,
  IPC.systemGetPermissions,
  IPC.systemAppInfo,
]);

const SETTINGS_CHANNELS = new Set<string>([
  IPC.historyList,
  IPC.historyDelete,
  IPC.historyClear,
  IPC.historyExport,
  IPC.dictionaryList,
  IPC.dictionarySave,
  IPC.dictionaryDelete,
  IPC.snippetsList,
  IPC.snippetsSave,
  IPC.snippetsDelete,
  IPC.profilesList,
  IPC.profilesSave,
  IPC.profilesDelete,
  IPC.settingsGet,
  IPC.settingsPatch,
  IPC.shortcutsBeginCapture,
  IPC.shortcutsEndCapture,
  IPC.shortcutsValidate,
  IPC.shortcutsUpdate,
  IPC.windowShowSettings,
  IPC.systemGetPermissions,
  IPC.systemGetLaunchAtLoginStatus,
  IPC.systemOpenPermission,
  IPC.systemAppInfo,
  IPC.systemDiagnostics,
  IPC.systemModelCatalog,
  IPC.systemAddModelFamily,
  IPC.systemActivateModelFamily,
  IPC.systemInstallModel,
  IPC.systemRemoveModel,
]);

const SCRATCHPAD_CHANNELS = new Set<string>([
  IPC.scratchpadList,
  IPC.scratchpadCreate,
  IPC.scratchpadUpdate,
  IPC.scratchpadDelete,
  IPC.windowCloseScratchpad,
  IPC.windowToggleScratchpadSize,
  IPC.systemAppInfo,
]);

export function rendererSurfaceCanInvoke(
  surface: RendererSurface,
  channel: string,
): boolean {
  if (surface === "settings") return SETTINGS_CHANNELS.has(channel);
  if (surface === "pill") return PILL_CHANNELS.has(channel);
  return SCRATCHPAD_CHANNELS.has(channel);
}

export function assertRendererSurfaceCanInvoke(
  surface: RendererSurface,
  channel: string,
): void {
  if (!rendererSurfaceCanInvoke(surface, channel)) {
    throw new Error(`Rejected ${channel} IPC from the ${surface} surface`);
  }
}
