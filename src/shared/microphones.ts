/**
 * The one definition of which input devices LocalScribe will accept.
 *
 * Settings persists `microphoneId` and the pill consumes it, so the two must
 * agree on what a selectable device is. They did not: the pill dropped the
 * platform's `"default"` pseudo-device and duplicate ids, Settings listed
 * whatever `enumerateDevices()` returned. Choosing "Default" in Settings
 * therefore stored an id the pill could not find, and the pill reported the
 * user's working microphone as unavailable.
 *
 * `"default"` is excluded rather than resolved because LocalScribe already
 * represents "follow the system default" as `microphoneId === null`. The
 * pseudo-device is a second spelling of that state whose meaning changes
 * underneath the stored value.
 */
export interface SelectableDevice {
  readonly kind: string;
  readonly deviceId: string;
}

export function selectableMicrophones<T extends SelectableDevice>(
  devices: readonly T[],
): T[] {
  const seen = new Set<string>();
  return devices.filter((device) => {
    if (
      device.kind !== "audioinput"
      || !device.deviceId
      || device.deviceId === "default"
      || seen.has(device.deviceId)
    ) {
      return false;
    }
    seen.add(device.deviceId);
    return true;
  });
}
