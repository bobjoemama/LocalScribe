import { describe, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "../src/shared/contracts";
import {
  acceptsLivePartial,
  holdShortcutPresentation,
  isCurrentFinalization,
  listSelectableMicrophones,
  livePartialText,
  listeningRecorderStart,
  selectedMicrophoneIsUnavailable,
  trySelectMicrophone,
} from "../src/renderer/pill/Pill";

const FIRST_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_SESSION_ID = "22222222-2222-4222-8222-222222222222";

describe("pill recorder lifecycle", () => {
  it("renders only the newest live partial for the current listening session", () => {
    const listening: SessionSnapshot = {
      state: "listening",
      sessionId: FIRST_SESSION_ID,
      activation: "toggle",
    };
    const current = { sessionId: FIRST_SESSION_ID, sequence: 4, text: "the revised phrase" };

    expect(acceptsLivePartial(listening, current, {
      sessionId: FIRST_SESSION_ID,
      sequence: 5,
      text: "the final revised phrase",
    })).toBe(true);
    expect(acceptsLivePartial(listening, current, {
      sessionId: FIRST_SESSION_ID,
      sequence: 4,
      text: "stale revision",
    })).toBe(false);
    expect(acceptsLivePartial(listening, current, {
      sessionId: SECOND_SESSION_ID,
      sequence: 6,
      text: "wrong session",
    })).toBe(false);
    expect(livePartialText({ state: "finalizing", sessionId: FIRST_SESSION_ID }, current)).toBeNull();
    expect(livePartialText({ state: "listening", sessionId: SECOND_SESSION_ID }, current)).toBeNull();
    expect(livePartialText(listening, current)).toBe("the revised phrase");
  });

  it("accepts finalization work only while the same session is still finalizing", () => {
    const finalizing: SessionSnapshot = {
      state: "finalizing",
      sessionId: FIRST_SESSION_ID,
    };
    expect(isCurrentFinalization(finalizing, FIRST_SESSION_ID)).toBe(true);
    expect(isCurrentFinalization(finalizing, SECOND_SESSION_ID)).toBe(false);

    expect(isCurrentFinalization({
      state: "idle",
    }, FIRST_SESSION_ID)).toBe(false);
    expect(isCurrentFinalization({
      state: "listening",
      sessionId: SECOND_SESSION_ID,
    }, FIRST_SESSION_ID)).toBe(false);
  });

  it("waits for persisted microphone settings before starting an immediate hotkey session", () => {
    const listening: SessionSnapshot = {
      state: "listening",
      sessionId: FIRST_SESSION_ID,
      activation: "hold",
    };

    expect(listeningRecorderStart(listening, "loading", null, null)).toBeNull();
    expect(listeningRecorderStart(
      listening,
      "ready",
      null,
      "persisted-windows-microphone",
    )).toEqual({
      sessionId: FIRST_SESSION_ID,
      microphoneId: "persisted-windows-microphone",
    });
    expect(listeningRecorderStart(
      listening,
      "ready",
      FIRST_SESSION_ID,
      "persisted-windows-microphone",
    )).toBeNull();
  });

  it("uses the system default only after settings are confirmed unavailable", () => {
    const listening: SessionSnapshot = {
      state: "listening",
      sessionId: SECOND_SESSION_ID,
      activation: "toggle",
    };

    expect(listeningRecorderStart(listening, "unavailable", null, null)).toEqual({
      sessionId: SECOND_SESSION_ID,
      microphoneId: null,
    });
  });
});

describe("pill shortcut presentation", () => {
  it("does not present Control as current until persisted settings are available", () => {
    expect(holdShortcutPresentation(null, "loading")).toEqual({
      tooltip: "Dictate · shortcut settings are loading",
      dictateAriaLabel: "Start dictating; shortcut settings are loading",
    });
    expect(holdShortcutPresentation(null, "unavailable")).toEqual({
      tooltip: "Dictate · shortcut settings are unavailable",
      dictateAriaLabel: "Start dictating; shortcut settings are unavailable",
    });
    expect(holdShortcutPresentation("Control", "ready")).toEqual({
      tooltip: "Dictate · platform details are loading",
      dictateAriaLabel: "Start dictating; platform details are loading",
    });
    expect(holdShortcutPresentation("Control", "ready", undefined, "unavailable")).toEqual({
      tooltip: "Dictate · platform details are unavailable",
      dictateAriaLabel: "Start dictating; platform details are unavailable",
    });
    expect(holdShortcutPresentation("Control", "ready", "unsupported")).toEqual({
      tooltip: "Dictate · shortcut unavailable on this platform",
      dictateAriaLabel: "Start dictating; shortcut unavailable on this platform",
    });
  });

  it("formats the persisted shortcut for the runtime platform", () => {
    expect(holdShortcutPresentation("Alt+Space", "ready", "darwin")).toEqual({
      tooltip: "Dictate · hold ⌥ + Space",
      dictateAriaLabel: "Start dictating; hold ⌥ + Space",
    });
    expect(holdShortcutPresentation("Alt+Space", "ready", "win32")).toEqual({
      tooltip: "Dictate · hold Alt + Space",
      dictateAriaLabel: "Start dictating; hold Alt + Space",
    });
    expect(holdShortcutPresentation("Command+Space", "ready", "win32")).toEqual({
      tooltip: "Dictate · hold Win + Space",
      dictateAriaLabel: "Start dictating; hold Win + Space",
    });
  });
});

describe("pill microphone selection", () => {
  it("lists only selectable, unique runtime microphone devices", async () => {
    const microphone = (
      deviceId: string,
      label: string,
      kind: MediaDeviceKind = "audioinput"
    ) => ({ deviceId, groupId: "", kind, label, toJSON: () => ({}) }) as MediaDeviceInfo;
    const enumerateDevices = vi.fn(async () => [
      microphone("default", "Default"),
      microphone("external", "External microphone"),
      microphone("external", "External microphone duplicate"),
      microphone("communications", "Communications"),
      microphone("", "Unselectable"),
      microphone("speaker", "Speakers", "audiooutput"),
    ]);

    await expect(listSelectableMicrophones({ enumerateDevices })).resolves.toEqual([
      expect.objectContaining({ deviceId: "external" }),
      expect.objectContaining({ deviceId: "communications" }),
    ]);
    expect(enumerateDevices).toHaveBeenCalledOnce();
  });

  it("detects a persisted device that disappeared from the live device list", () => {
    const devices = [{ deviceId: "built-in" }, { deviceId: "usb-microphone" }];

    expect(selectedMicrophoneIsUnavailable("disconnected-microphone", devices)).toBe(true);
    expect(selectedMicrophoneIsUnavailable("usb-microphone", devices)).toBe(false);
    expect(selectedMicrophoneIsUnavailable(null, devices)).toBe(false);
  });

  it("reports device discovery as unavailable instead of treating a missing API as an empty list", async () => {
    await expect(listSelectableMicrophones(undefined))
      .rejects.toThrow("Media device discovery is unavailable");
  });

  it("contains settings failures so the picker can present local feedback", async () => {
    const select = vi.fn(async () => {
      throw new Error("settings write failed");
    });

    await expect(trySelectMicrophone(select, "external-microphone")).resolves.toBe(false);
    expect(select).toHaveBeenCalledWith("external-microphone");
  });

  it("reports successful persisted selections", async () => {
    const select = vi.fn(async () => undefined);

    await expect(trySelectMicrophone(select, null)).resolves.toBe(true);
    expect(select).toHaveBeenCalledWith(null);
  });
});
