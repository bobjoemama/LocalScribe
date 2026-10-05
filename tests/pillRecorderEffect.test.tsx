import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, SessionSnapshot } from "../src/shared/contracts";
import { AudioRecorder } from "../src/renderer/audioRecorder";
import { Pill } from "../src/renderer/pill/Pill";

const effects = vi.hoisted(() => [] as Array<() => void | (() => void)>);
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => effects.push(effect),
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => [initial, vi.fn()],
}));

function harness(deferSettings = false) {
  let change!: (snapshot: SessionSnapshot) => void;
  let resolveSettings!: (settings: AppSettings) => void;
  const settings = { microphoneId: null, holdShortcut: "Control+Space", asrMode: "after-stop" } as AppSettings;
  const settingsReady = deferSettings
    ? new Promise<AppSettings>((resolve) => { resolveSettings = resolve; })
    : Promise.resolve(settings);
  vi.stubGlobal("window", {
    localScribe: {
      session: {
        onChanged: (callback: typeof change) => { change = callback; return vi.fn(); },
        onLivePartial: () => vi.fn(),
        get: () => Promise.resolve({ state: "idle" }),
        fail: vi.fn().mockResolvedValue(undefined),
      },
      settings: { get: () => settingsReady, onChanged: () => vi.fn() },
    },
  });
  const start = vi.spyOn(AudioRecorder.prototype, "start").mockResolvedValue(undefined);
  const cancel = vi.spyOn(AudioRecorder.prototype, "cancel").mockResolvedValue(undefined);
  Pill();
  const cleanup = effects[0]!();
  return {
    start, cancel,
    listen: () => change({ state: "listening", sessionId: "11111111-1111-4111-8111-111111111111", activation: "toggle" }),
    error: () => change({ state: "error", message: "Local runtime failed" }),
    unmount: () => { if (typeof cleanup === "function") cleanup(); },
    finishSettings: () => resolveSettings(settings),
  };
}

describe("the actual pill recorder effect", () => {
  beforeEach(() => { effects.length = 0; });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("cancels microphone capture when main reports a listening-session error", async () => {
    const fixture = harness();
    await Promise.resolve();
    fixture.listen();
    expect(fixture.start).toHaveBeenCalledOnce();
    fixture.error();
    expect(fixture.cancel).toHaveBeenCalledOnce();
  });

  it("cancels capture when the pill unmounts", async () => {
    const fixture = harness();
    await Promise.resolve();
    fixture.listen();
    fixture.unmount();
    expect(fixture.cancel).toHaveBeenCalledOnce();
  });

  it("does not start a microphone from settings that resolve after unmount", async () => {
    const fixture = harness(true);
    await Promise.resolve();
    fixture.listen();
    fixture.unmount();
    fixture.finishSettings();
    await Promise.resolve();
    expect(fixture.start).not.toHaveBeenCalled();
  });
});
