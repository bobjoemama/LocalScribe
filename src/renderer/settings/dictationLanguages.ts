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
