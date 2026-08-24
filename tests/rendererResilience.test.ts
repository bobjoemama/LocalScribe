import { describe, expect, it, vi } from "vitest";

import {
  dictationMenuPolicy,
  rendererFailureRecoveryPolicy,
  sendToLiveRenderers,
  type RendererEndpoint,
} from "../src/main/session/rendererResilience";

function endpoint(options: {
  windowDestroyed?: boolean;
  contentsDestroyed?: boolean;
  send?: (channel: string, payload: unknown) => void;
} = {}): RendererEndpoint {
  return {
    isDestroyed: () => options.windowDestroyed ?? false,
    webContents: {
      isDestroyed: () => options.contentsDestroyed ?? false,
      send: options.send ?? (() => undefined),
    },
  };
}

describe("best-effort renderer delivery", () => {
  it("delivers to every live renderer and skips destroyed endpoints", () => {
    const send = vi.fn();
    const failed = vi.fn();
    const delivered = sendToLiveRenderers([
      endpoint({ send }),
      endpoint({ windowDestroyed: true, send }),
      endpoint({ contentsDestroyed: true, send }),
      null,
    ], "session-changed", { state: "listening" }, failed);

    expect(delivered).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
  });

  it("contains a throwing webContents and continues to the next renderer", () => {
    const send = vi.fn();
    const failure = new Error("renderer disappeared");
    const failed = vi.fn();
    const throwing = {
      isDestroyed: () => false,
      get webContents(): never {
        throw failure;
      },
    } as RendererEndpoint;

    expect(sendToLiveRenderers([
      throwing,
      endpoint({ send: () => { throw failure; } }),
      endpoint({ send }),
    ], "session-changed", { state: "idle" }, failed)).toBe(1);
    expect(failed).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledOnce();
  });

  it("keeps delivering when the failure reporter also throws", () => {
    const send = vi.fn();
    expect(sendToLiveRenderers([
      endpoint({ send: () => { throw new Error("gone"); } }),
      endpoint({ send }),
    ], "session-changed", { state: "idle" }, () => {
      throw new Error("logger unavailable");
    })).toBe(1);
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("renderer failure recovery policy", () => {
  it("fails an active dictation only for a failed pill renderer", () => {
    for (const surface of ["settings", "scratchpad"] as const) {
      expect(rendererFailureRecoveryPolicy({
        surface,
        quitting: false,
        hasActiveDictation: true,
        recoveryAlreadyInFlight: false,
        wasVisible: true,
      }).failActiveDictation).toBe(false);
    }
    expect(rendererFailureRecoveryPolicy({
      surface: "pill",
      quitting: false,
      hasActiveDictation: true,
      recoveryAlreadyInFlight: false,
      wasVisible: true,
    }).failActiveDictation).toBe(true);
  });

  it("permits one automatic replacement and never activates it", () => {
    expect(rendererFailureRecoveryPolicy({
      surface: "settings",
      quitting: false,
      hasActiveDictation: false,
      recoveryAlreadyInFlight: false,
      wasVisible: true,
    })).toEqual({
      failActiveDictation: false,
      recreate: true,
      restoreVisibleInactive: true,
    });
    expect(rendererFailureRecoveryPolicy({
      surface: "settings",
      quitting: false,
      hasActiveDictation: false,
      recoveryAlreadyInFlight: true,
      wasVisible: true,
    })).toEqual({
      failActiveDictation: false,
      recreate: false,
      restoreVisibleInactive: false,
    });
  });

  it("does nothing during shutdown", () => {
    expect(rendererFailureRecoveryPolicy({
      surface: "pill",
      quitting: true,
      hasActiveDictation: true,
      recoveryAlreadyInFlight: false,
      wasVisible: true,
    })).toEqual({
      failActiveDictation: false,
      recreate: false,
      restoreVisibleInactive: false,
    });
  });
});

describe("dictation menu policy", () => {
  it("offers only actions that the current session can perform", () => {
    expect(dictationMenuPolicy("idle", false)).toMatchObject({ action: "start", enabled: true });
    expect(dictationMenuPolicy("listening", false)).toMatchObject({ action: "stop", enabled: true });
    for (const state of ["finalizing", "transcribing", "inserting"] as const) {
      expect(dictationMenuPolicy(state, false)).toMatchObject({ action: null, enabled: false });
    }
  });

  it("disables start while a serialized model operation is active", () => {
    expect(dictationMenuPolicy("idle", true)).toEqual({
      label: "Model Operation in Progress…",
      enabled: false,
      action: null,
    });
  });
});
