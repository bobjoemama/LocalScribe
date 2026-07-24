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
