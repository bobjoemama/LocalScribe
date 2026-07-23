function normalizedPathLikeId(value: string): string {
  return value
    .trim()
    .replace(/\\/gu, "/")
    .replace(/\/{2,}/gu, "/")
    .replace(/\/$/u, "")
    .toLocaleLowerCase("en-US");
}

export function normalizeApplicationId(value: string): string {
  return normalizedPathLikeId(value);
}

export function applicationIdsMatch(configuredId: string, capturedId: string): boolean {
  const configured = normalizeApplicationId(configuredId);
  const captured = normalizeApplicationId(capturedId);
  if (!configured || !captured) return false;
  if (configured === captured) return true;

  // Windows target capture returns the full executable path, while a person may
  // reasonably configure the executable name shown by the UI. Match a basename
  // only when one side is path-qualified; bundle identifiers never enter this
  // branch.
  const configuredIsPath = configured.includes("/");
  const capturedIsPath = captured.includes("/");
  if (!configuredIsPath && !capturedIsPath) return false;
  return configured.split("/").at(-1) === captured.split("/").at(-1);
}
