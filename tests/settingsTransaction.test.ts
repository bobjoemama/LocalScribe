import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type AppSettings } from "../src/shared/contracts";
import {
  applySettingsPatchTransaction,
  applyShortcutUpdateTransaction,
} from "../src/main/settings/settingsTransaction";

function transactionHarness(initial: AppSettings = DEFAULT_SETTINGS) {
  let persisted = initial;
  return {
    database: {
      getSettings: vi.fn(() => persisted),
      saveSettings: vi.fn((next: AppSettings) => {
        persisted = next;
        return next;
      }),
    },
    hotkeys: { reconfigure: vi.fn() },
    get persisted() { return persisted; },
  };
}

describe("settings patch and shortcut transactions", () => {
  it("commits Command+Control immediately and a stale non-shortcut writer preserves it", () => {
    const harness = transactionHarness();
    const dependencies = { database: harness.database, hotkeys: harness.hotkeys };

    const committed = applyShortcutUpdateTransaction(dependencies, {
      kind: "hold",
      shortcut: "Command+Control",
    });
    expect(committed.holdShortcut).toBe("Command+Control");
    expect(harness.hotkeys.reconfigure).toHaveBeenCalledWith("Command+Control", "Control+Space");

    // This represents Style/Transforms/Pill holding an old whole settings
    // object and submitting only its changed field through settings:patch.
    const afterStaleWriter = applySettingsPatchTransaction(dependencies, {
      smartPunctuation: false,
    });
    expect(afterStaleWriter).toMatchObject({
      holdShortcut: "Command+Control",
      smartPunctuation: false,
    });
    expect(harness.persisted.holdShortcut).toBe("Command+Control");
    expect(harness.hotkeys.reconfigure).toHaveBeenCalledTimes(1);
  });

  it("does not persist a shortcut when activation fails and restores activation if persistence fails", () => {
    const harness = transactionHarness();
    const dependencies = { database: harness.database, hotkeys: harness.hotkeys };
    harness.hotkeys.reconfigure.mockImplementationOnce(() => {
      throw new Error("occupied");
    });

    expect(() => applyShortcutUpdateTransaction(dependencies, { kind: "toggle", shortcut: "F13" }))
      .toThrow("occupied");
    expect(harness.database.saveSettings).not.toHaveBeenCalled();

    harness.hotkeys.reconfigure.mockReset();
    harness.database.saveSettings.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => applyShortcutUpdateTransaction(dependencies, { kind: "hold", shortcut: "Command+Control" }))
      .toThrow("disk full");
    expect(harness.hotkeys.reconfigure).toHaveBeenNthCalledWith(1, "Command+Control", "Control+Space");
    expect(harness.hotkeys.reconfigure).toHaveBeenNthCalledWith(2, "Control", "Control+Space");
  });
});
