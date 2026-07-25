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
