import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { IPC } from "../src/shared/contracts";

const root = resolve(process.cwd());

function source(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("validated settings-change delivery", () => {
  it("uses one contract event from the trusted main process through preload to live renderers", () => {
    expect(IPC.settingsChanged).toBe("settings:changed");
    expect(IPC.settingsPatch).toBe("settings:patch");
    expect(IPC.shortcutsUpdate).toBe("shortcuts:update");
    expect(source("src/main.ts")).toContain("notifySettingsChanged(settings);");
    expect(source("src/main.ts")).toContain("applyShortcutUpdateTransaction({ database, hotkeys }, input)");
    expect(source("src/preload.ts")).toContain("appSettingsSchema.parse(value)");
    expect(source("src/renderer/pill/Pill.tsx")).toContain("settings.onChanged((settings) =>");
    expect(source("src/renderer/pill/Pill.tsx")).toContain("applySettings(settings);");
    expect(source("src/renderer/pill/Pill.tsx")).not.toContain("setInterval(refreshSettings");
    expect(source("src/renderer/settings/screens/HistoryInsights.tsx")).toContain("settings.onChanged((settings) =>");
    expect(source("src/renderer/settings/screens/HistoryInsights.tsx")).toContain("setShortcutSettings(settings);");
    expect(source("src/renderer/settings/screens/StyleSettings.tsx")).toContain("settings.onChanged(applyPersistedSettings)");
  });

  it("uses the field patch path for stale-prone settings writers and direct commit for recording", () => {
    expect(source("src/renderer/pill/Pill.tsx")).toContain("settings.patch({ microphoneId: nextMicrophoneId })");
    expect(IPC).not.toHaveProperty("settingsSave");
    expect(source("src/preload.ts")).not.toContain("settings.save");
    const settings = source("src/renderer/settings/screens/StyleSettings.tsx");
    expect(settings).toContain("settings.patch({");
    expect(settings).toContain("shortcuts.update({ kind, shortcut })");
    expect(settings).not.toContain("settings.save(");
  });
});

/*
 * The permission poll spawns a native helper on every tick, so it must stop
 * when nobody can see the result. It cannot use the Page Visibility API:
 * `backgroundThrottling: false` pins `document.visibilityState` to "visible"
 * in a hidden window, and closing a window only hides it. Main therefore owns
 * the signal — and none of that had any test at all, so any one of the three
 * ends could be removed and the suite would stay green.
 */
describe("native window visibility drives the permission poll", () => {
  it("sends the real native visibility from main on every transition", () => {
    expect(IPC.windowVisibility).toBe("window:visibility");
    const main = source("src/main.ts");
    const reporter = main.slice(
      main.indexOf("function reportWindowVisibility(window: BrowserWindow): void"),
      main.indexOf("function createSettingsWindow("),
    );

    expect(reporter).toContain("sendToLiveRenderers([window], IPC.windowVisibility, visible");
    for (const [event, visible] of [
      ["show", "true"],
      ["restore", "true"],
      ["hide", "false"],
      ["minimize", "false"],
    ] as const) {
      expect(reporter, `missing ${event} transition`).toContain(`window.on("${event}", () => send(${visible}));`);
    }
    // A window that loads while already hidden must not be told it is visible.
    expect(reporter).toContain('window.webContents.on("did-finish-load", () => send(window.isVisible()));');
    // Sending to a torn-down window throws; the shared broadcaster owns both
    // checks and the teardown race for every renderer notification.
    const delivery = source("src/main/session/rendererResilience.ts");
    expect(delivery).toContain("if (window.isDestroyed()) continue;");
    expect(delivery).toContain("if (contents.isDestroyed()) continue;");
    expect(delivery).toContain("} catch (error) {");
  });

  it("validates the pushed value in preload and hands back an unsubscribe", () => {
    const preload = source("src/preload.ts");
    const bridge = preload.slice(
      preload.indexOf("onVisibilityChanged:"),
      preload.indexOf("onPillModeChanged:"),
    );

    expect(bridge).toContain("z.boolean().parse(visible)");
    expect(bridge).toContain("ipcRenderer.on(IPC.windowVisibility, wrapped)");
    expect(bridge).toContain("return () => ipcRenderer.removeListener(IPC.windowVisibility, wrapped);");
  });

  it("stops the poll when hidden and refreshes immediately when shown again", () => {
    const settings = source("src/renderer/settings/screens/StyleSettings.tsx");
    const subscription = settings.slice(
      settings.indexOf("const unsubscribeVisibility = window.localScribe.windows.onVisibilityChanged"),
      settings.indexOf('window.addEventListener("focus", refreshForegroundState);'),
    );

    expect(subscription).toContain("if (!visible) {");
    expect(subscription).toContain("stopPolling();");
    // Permissions can change in System Settings while the window is away, so a
    // return to visible must refresh before the next tick, not after it.
    const refreshIndex = subscription.indexOf("refreshForegroundState();");
    const startIndex = subscription.indexOf("startPolling();");
    expect(refreshIndex).toBeGreaterThan(0);
    expect(startIndex).toBeGreaterThan(refreshIndex);
    // The listener must be released, or a reopened window polls twice per tick.
    expect(settings).toContain("unsubscribeVisibility();");
  });
});
