import type { ModelCapabilities } from "../../shared/contracts";

/**
 * The language choices currently exposed by the renderer. Keep this list
 * deliberately small and shared so the UI does not advertise a language that
 * this build has not verified across its supported local speech engines.
 */
export const DICTATION_LANGUAGE_OPTIONS = [
  { value: "auto", label: "Auto-detect" },
  { value: "English", label: "English" },
  { value: "Spanish", label: "Spanish" },
  { value: "French", label: "French" },
  { value: "German", label: "German" },
  { value: "Hindi", label: "Hindi" },
] as const;

export const DICTATION_LANGUAGE_DETAIL =
  "Auto-detect or select one of the languages supported in this build.";

type DictationLanguageOption = (typeof DICTATION_LANGUAGE_OPTIONS)[number];
type ModelLanguageCapabilities = Pick<ModelCapabilities, "languageDetection" | "supportedLanguages">;

const LANGUAGE_CODE_BY_VALUE: Readonly<Record<Exclude<DictationLanguageOption["value"], "auto">, string>> = {
  English: "en",
  Spanish: "es",
  French: "fr",
  German: "de",
  Hindi: "hi",
};

function optionForSingleLanguageModel(
  option: DictationLanguageOption,
  capability: ModelLanguageCapabilities,
): { value: string; label: string } | null {
  if (option.value === "auto") {
    if (capability.supportedLanguages.includes("auto")) {
      return capability.languageDetection
        ? option
        : { value: "auto", label: "Automatic (model default)" };
    }
    const explicitLanguages = capability.supportedLanguages.filter((language) => language !== "auto");
    if (explicitLanguages.length !== 1) return null;
    const matching = DICTATION_LANGUAGE_OPTIONS.find((candidate) => (
      candidate.value !== "auto" && LANGUAGE_CODE_BY_VALUE[candidate.value] === explicitLanguages[0]
    ));
    return matching
      ? { value: "auto", label: `${matching.label} (automatic)` }
      : null;
  }
  return capability.supportedLanguages.includes(LANGUAGE_CODE_BY_VALUE[option.value]) ? option : null;
}

export interface DictationLanguagePresentation {
  enabled: boolean;
  detail: string;
  options: readonly { value: string; label: string; disabled?: boolean }[];
}

/**
 * Models do not share language coverage: Parakeet Unified is English-only,
 * while a multilingual family can detect or accept multiple languages. The
 * selector is derived from the staged family so it never advertises a language
 * the next Apply would make impossible. A previously saved incompatible value
 * remains visible (and disabled) instead of becoming a blank select.
 */
export function dictationLanguagePresentation(
  savedLanguage: string,
  capability: ModelLanguageCapabilities | null | undefined,
): DictationLanguagePresentation {
  if (!capability) {
    return {
      enabled: false,
      detail: "Loading language support for the selected local model. Choose a language after model status is ready.",
      options: dictationLanguageOptionsFor(savedLanguage),
    };
  }
  const options = DICTATION_LANGUAGE_OPTIONS
    .map((option) => optionForSingleLanguageModel(option, capability))
    .filter((option): option is { value: string; label: string } => option !== null);
  const savedIsOffered = options.some((option) => option.value === savedLanguage);
  const detail = capability.languageDetection && capability.supportedLanguages.includes("auto")
    ? "Auto-detect or choose a language supported by the selected local model."
    : capability.supportedLanguages.length === 1
      && capability.supportedLanguages[0] === "auto"
      ? "Automatic uses the selected local model’s default language. This model does not expose language detection."
      : capability.supportedLanguages.length === 1
      ? `The selected local model supports ${options.find((option) => option.value !== "auto")?.label ?? "one language"} only. “Automatic” uses that language; it does not detect language.`
      : "Choose a language supported by the selected local model.";
  return {
    enabled: true,
    detail: savedIsOffered
      ? detail
      : `${detail} ${savedLanguage} is saved but unsupported by this model; choose a supported language before dictating.`,
    options: savedIsOffered
      ? options
      : [{ value: savedLanguage, label: `${savedLanguage} (saved; unsupported by selected model)`, disabled: true }, ...options],
  };
}

/**
 * Preserve an older saved language visibly even when the current build no
 * longer offers it as a verified choice. A controlled <select> must never
 * render as an unexplained blank value.
 */
export function dictationLanguageOptionsFor(savedLanguage: string) {
  if (DICTATION_LANGUAGE_OPTIONS.some((option) => option.value === savedLanguage)) {
    return DICTATION_LANGUAGE_OPTIONS;
  }
  return [
    {
      value: savedLanguage,
      label: `${savedLanguage} (saved; not offered in this build)`,
    },
    ...DICTATION_LANGUAGE_OPTIONS,
  ] as const;
}
