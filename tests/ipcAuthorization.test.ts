import { describe, expect, it } from "vitest";
import {
  assertRendererSurfaceCanInvoke,
  rendererSurfaceCanInvoke,
} from "../src/main/ipcAuthorization";
import { IPC } from "../src/shared/contracts";

describe("renderer IPC authorization", () => {
  it("keeps model, history, and data administration in the Settings hub", () => {
    for (const channel of [
      IPC.systemInstallModel,
      IPC.systemRemoveModel,
      IPC.systemGetLaunchAtLoginStatus,
      IPC.historyClear,
      IPC.dictionaryDelete,
    ]) {
      expect(rendererSurfaceCanInvoke("settings", channel)).toBe(true);
      expect(rendererSurfaceCanInvoke("pill", channel)).toBe(false);
      expect(rendererSurfaceCanInvoke("scratchpad", channel)).toBe(false);
    }
  });

  it("fails closed for Settings channels that are unrelated or added later", () => {
    expect(rendererSurfaceCanInvoke("settings", IPC.sessionTranscribe)).toBe(false);
    expect(rendererSurfaceCanInvoke("settings", IPC.scratchpadDelete)).toBe(false);
    expect(rendererSurfaceCanInvoke("settings", "future:unknown-channel")).toBe(false);
  });

  it("allows only the pill's dictation and presentation operations", () => {
    expect(rendererSurfaceCanInvoke("pill", IPC.sessionTranscribe)).toBe(true);
    expect(rendererSurfaceCanInvoke("pill", IPC.windowSetPillMode)).toBe(true);
    expect(rendererSurfaceCanInvoke("pill", IPC.systemGetPermissions)).toBe(true);
    expect(() => assertRendererSurfaceCanInvoke("pill", IPC.systemRemoveModel))
      .toThrow("Rejected");
  });

  it("limits Scratchpad to note and window operations", () => {
    expect(rendererSurfaceCanInvoke("scratchpad", IPC.scratchpadUpdate)).toBe(true);
    expect(rendererSurfaceCanInvoke("scratchpad", IPC.windowCloseScratchpad)).toBe(true);
    expect(rendererSurfaceCanInvoke("scratchpad", IPC.settingsPatch)).toBe(false);
    expect(rendererSurfaceCanInvoke("scratchpad", IPC.sessionTranscribe)).toBe(false);
  });
});
