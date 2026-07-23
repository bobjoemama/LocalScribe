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
    expect(source("src/main.ts")).toContain("notifySettingsChanged(settings);");
    expect(source("src/preload.ts")).toContain("appSettingsSchema.parse(value)");
    expect(source("src/renderer/pill/Pill.tsx")).toContain("settings.onChanged(applySettings)");
    expect(source("src/renderer/pill/Pill.tsx")).not.toContain("setInterval(refreshSettings");
    expect(source("src/renderer/settings/screens/HistoryInsights.tsx")).toContain("settings.onChanged(setShortcutSettings)");
  });
});
