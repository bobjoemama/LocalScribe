import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { selectableMicrophones } from "../src/shared/microphones";

function device(deviceId: string, kind = "audioinput") {
  return { deviceId, kind, label: deviceId };
}

describe("selectableMicrophones", () => {
  it("keeps ordinary input devices in order", () => {
    expect(selectableMicrophones([
      device("mic-a"),
      device("mic-b"),
    ]).map((entry) => entry.deviceId)).toEqual(["mic-a", "mic-b"]);
  });

  /*
   * The defect: Settings listed this pseudo-device, the pill rejected it. The
   * user picked "Default", the id was persisted, and the pill then reported the
   * microphone as unavailable — while recording through it perfectly well.
   * "Follow the system default" is `microphoneId === null`, not this id.
   */
  it("drops the platform default pseudo-device", () => {
    expect(selectableMicrophones([
      device("default"),
      device("mic-a"),
    ]).map((entry) => entry.deviceId)).toEqual(["mic-a"]);
  });

  it("drops output devices, blank ids, and duplicates", () => {
    expect(selectableMicrophones([
      device("speaker", "audiooutput"),
      device(""),
      device("mic-a"),
      device("mic-a"),
      device("camera", "videoinput"),
    ]).map((entry) => entry.deviceId)).toEqual(["mic-a"]);
  });

  it("returns nothing when the machine exposes no input devices", () => {
    expect(selectableMicrophones([device("default"), device("speaker", "audiooutput")])).toEqual([]);
  });
});

/*
 * A shared helper only fixes the mismatch if both screens actually call it, and
 * this is exactly the kind of divergence that reappears the next time either
 * screen is edited.
 */
describe("both microphone consumers use the shared filter", () => {
  it.each([
    "src/renderer/pill/Pill.tsx",
    "src/renderer/settings/screens/StyleSettings.tsx",
  ])("%s filters through selectableMicrophones", (relativePath) => {
    const source = readFileSync(relativePath, "utf8");

    expect(source).toContain("selectableMicrophones");
    // Neither screen may re-derive its own list from enumerateDevices().
    const enumerations = [...source.matchAll(/enumerateDevices\(\)/gu)];
    for (const match of enumerations) {
      const call = source.slice(Math.max(0, (match.index ?? 0) - 120), (match.index ?? 0) + 40);
      expect(call, `unfiltered enumerateDevices() in ${relativePath}`).toContain("selectableMicrophones");
    }
    expect(enumerations.length).toBeGreaterThan(0);
  });
});
