import { describe, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "../src/shared/contracts";
import type { LiveAudioSink } from "../src/shared/liveAudioTransport";
import {
  acceptsLivePartial,
  holdShortcutPresentation,
  isCurrentFinalization,
  listSelectableMicrophones,
  livePartialText,
  listeningRecorderStart,
  selectedMicrophoneIsUnavailable,
  startLiveRecorderForCurrentSession,
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
      "persisted-usb-microphone",
    )).toEqual({
      sessionId: FIRST_SESSION_ID,
      microphoneId: "persisted-usb-microphone",
    });
    expect(listeningRecorderStart(
      listening,
      "ready",
      FIRST_SESSION_ID,
      "persisted-usb-microphone",
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

  it("aborts a deferred Live sink when a newer listening session wins before microphone start", async () => {
    let resolveSink!: (sink: LiveAudioSink) => void;
    const abort = vi.fn().mockResolvedValue(undefined);
    const sinkPromise = new Promise<LiveAudioSink>((resolve) => {
      resolveSink = resolve;
    });
    let current: SessionSnapshot = {
      state: "listening",
      sessionId: FIRST_SESSION_ID,
      activation: "toggle",
    };
    let recorderSessionId: string | null = FIRST_SESSION_ID;
    const startRecorder = vi.fn().mockResolvedValue(undefined);

    const starting = startLiveRecorderForCurrentSession({
      sessionId: FIRST_SESSION_ID,
      openSink: () => sinkPromise,
      currentSnapshot: () => current,
      currentRecorderSessionId: () => recorderSessionId,
      startRecorder,
    });
    current = {
      state: "listening",
      sessionId: SECOND_SESSION_ID,
      activation: "toggle",
    };
    recorderSessionId = SECOND_SESSION_ID;
    resolveSink({ write: () => undefined, finish: () => undefined, abort });

    await expect(starting).resolves.toBe(false);
    expect(abort).toHaveBeenCalledOnce();
    expect(startRecorder).not.toHaveBeenCalled();
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
      tooltip: "Dictate · hold ⌃",
      dictateAriaLabel: "Start dictating; hold ⌃",
    });
  });

  it("formats the persisted shortcut for the runtime platform", () => {
    expect(holdShortcutPresentation("Alt+Space", "ready")).toEqual({
      tooltip: "Dictate · hold ⌥ + Space",
      dictateAriaLabel: "Start dictating; hold ⌥ + Space",
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
