import { describe, expect, it } from "vitest";
import { historyShortcutPresentation } from "../src/renderer/settings/screens/HistoryInsights";

describe("history shortcut presentation", () => {
  it("keeps shortcut labels neutral until settings have loaded or recovered", () => {
    expect(historyShortcutPresentation(null, "loading")).toEqual({
      ariaLabel: "Shortcut settings are loading",
      holdLabel: "Shortcut settings are loading",
      toggleLabel: null,
    });
    expect(historyShortcutPresentation(null, "unavailable")).toEqual({
      ariaLabel: "Shortcut settings are unavailable",
      holdLabel: "Shortcut settings are unavailable",
      toggleLabel: null,
    });
    const ready = historyShortcutPresentation({
      holdShortcut: "Control",
      toggleShortcut: "Control+Space",
    }, "ready");
    expect(ready.ariaLabel).toMatch(/^Hold .+ to dictate; .+ toggles dictation$/);
    expect(ready.holdLabel).toMatch(/^Hold /);
    expect(ready.toggleLabel).toBeTruthy();
  });
});
