import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const main = readFileSync("src/main.ts", "utf8");
const appearanceFunctions = main.slice(
  main.indexOf("function workspaceBackgroundColor():"),
  main.indexOf("function createSettingsWindow("),
);
type Appearance = "system" | "light" | "dark";

function appearanceHarness() {
  let systemDark = false;
  let source: Appearance = "system";
  const settingsWindow = { isDestroyed: () => false, setBackgroundColor: vi.fn() };
  const scratchpadWindow = { isDestroyed: () => false, setBackgroundColor: vi.fn() };
  const pillWindow = { isDestroyed: () => false, setBackgroundColor: vi.fn() };
  const theme = {
    get themeSource() { return source; },
    set themeSource(next: Appearance) { source = next; },
    get shouldUseDarkColors() { return source === "dark" || (source === "system" && systemDark); },
  };
  const context = { nativeTheme: theme, settingsWindow, scratchpadWindow, pillWindow, quitting: false };
  const script = ts.transpileModule(appearanceFunctions, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const api = runInNewContext(`${script}\n({applyAppearance, updateWorkspaceWindowBackgrounds, workspaceBackgroundColor})`, context) as {
    applyAppearance(source: Appearance): void;
    updateWorkspaceWindowBackgrounds(): void;
    workspaceBackgroundColor(): string;
  };
  return { api, context, theme, setSystemDark(value: boolean) { systemDark = value; } };
}

describe("native workspace appearance", () => {
  it("applies saved overrides to every workspace window while keeping the pill black", () => {
    const { api, context, theme, setSystemDark } = appearanceHarness();
    api.applyAppearance("dark");
    expect(theme.themeSource).toBe("dark");
    for (const window of [context.settingsWindow, context.scratchpadWindow]) {
      expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#141312");
    }
    setSystemDark(true);
    api.applyAppearance("light");
    expect(api.workspaceBackgroundColor()).toBe("#F3F1ED");
    expect(context.pillWindow.setBackgroundColor).not.toHaveBeenCalled();
  });

  it("tracks subsequent system changes and avoids destroyed windows or shutdown", () => {
    const harness = appearanceHarness();
    harness.api.applyAppearance("system");
    harness.setSystemDark(true);
    harness.api.updateWorkspaceWindowBackgrounds();
    expect(harness.context.settingsWindow.setBackgroundColor).toHaveBeenLastCalledWith("#141312");
    harness.context.scratchpadWindow.isDestroyed = () => true;
    harness.context.scratchpadWindow.setBackgroundColor.mockClear();
    harness.api.updateWorkspaceWindowBackgrounds();
    expect(harness.context.scratchpadWindow.setBackgroundColor).not.toHaveBeenCalled();
    harness.context.quitting = true;
    harness.context.settingsWindow.setBackgroundColor.mockClear();
    harness.api.updateWorkspaceWindowBackgrounds();
    expect(harness.context.settingsWindow.setBackgroundColor).not.toHaveBeenCalled();
  });

  it("restores appearance before opening windows, after durable Save, and retires the listener on Quit", () => {
    const startup = main.slice(main.indexOf("startupPromise = app.whenReady().then"));
    expect(startup.indexOf("applyAppearance(database.getSettings().appearance)"))
      .toBeLessThan(startup.indexOf("pillWindow = createPillWindow()"));
    expect(startup).toContain('nativeTheme.on("updated", updateWorkspaceWindowBackgrounds)');
    const patch = main.slice(main.indexOf("handle(IPC.settingsPatch"), main.indexOf("handle(IPC.shortcutsBeginCapture"));
    expect(patch.indexOf("applySettingsPatchTransaction"))
      .toBeLessThan(patch.indexOf("applyAppearance(settings.appearance)"));
    expect(main).toContain('nativeTheme.removeListener("updated", updateWorkspaceWindowBackgrounds)');
    expect(main).toContain('{ role: "close", accelerator: "CommandOrControl+W" }');
    expect(main).toContain("hideWindowInsteadOfClosing(window)");
  });
});
