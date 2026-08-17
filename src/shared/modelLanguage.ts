import type { ModelCapabilities } from "./contracts";

const SETTINGS_LANGUAGE_CODES: Readonly<Record<string, string>> = {
  english: "en",
  spanish: "es",
  french: "fr",
  german: "de",
  hindi: "hi",
};

function configuredLanguageCode(value: string): string | "auto" | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "auto" || normalized === "automatic") return "auto";
  if (/^[a-z]{2,3}$/u.test(normalized)) return normalized;
  return SETTINGS_LANGUAGE_CODES[normalized] ?? null;
}

/**
 * Resolve a persisted display value to the canonical worker language code.
 *
 * An English-only recognizer such as Parakeet has no language detector, but
 * historic settings commonly store `Auto`. Treat that legacy value as the
 * model's one possible language (`en`) so an already-applied runtime remains
 * usable. Other unsupported values remain explicit errors instead of silently
 * changing the user's saved setting.
 */
export function workerLanguageForModel(
  language: string,
  capabilities: Pick<ModelCapabilities, "supportedLanguages">,
  modelName: string,
): string {
  const code = configuredLanguageCode(language);
  const englishOnly = capabilities.supportedLanguages.length === 1
    && capabilities.supportedLanguages[0] === "en";
  if (code === "auto") {
    if (capabilities.supportedLanguages.includes("auto")) return "auto";
    if (englishOnly) return "en";
  }
  if (code !== null && code !== "auto" && capabilities.supportedLanguages.includes(code)) return code;

  const requested = code === "auto" ? "Auto-detect" : language;
  const recommendation = englishOnly
    ? " Set Dictation language to English before applying or dictating with this model."
    : " Choose a language supported by this model before applying or dictating.";
  throw new Error(`${modelName} does not support ${requested}.${recommendation}`);
}
