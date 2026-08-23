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
  return configured === captured;
}
