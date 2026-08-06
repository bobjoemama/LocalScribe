import { rendererSafeErrorMessage } from "./rendererErrors";

export const ERROR_NOTICE_DURATION_MS = 8_000;

/**
 * How long the pill shows a finished dictation before returning to idle.
 *
 * Unchanged from the value that used to live inline at the transcribe call
 * site; it moved here so the transition can arm its own return to idle rather
 * than depending on a caller reaching the line after it.
 */
export const SUCCESS_NOTICE_DURATION_MS = 1_400;

export interface DictationErrorPresentation {
  title: string;
  detail: string;
}

export type DictationErrorPlatform = "darwin" | "win32" | "linux" | "unsupported";

const FALLBACK_MESSAGE = "Dictation could not finish";
const FALLBACK_DETAIL = "Try again. If this keeps happening, quit and reopen LocalScribe.";

export function normalizeDictationErrorMessage(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : FALLBACK_MESSAGE;
  const compact = raw.replace(/\s+/g, " ").trim();
  return (compact || FALLBACK_MESSAGE).slice(0, 240);
}

export function presentDictationError(
  error: unknown,
  platform?: DictationErrorPlatform,
): DictationErrorPresentation {
  const message = normalizeDictationErrorMessage(error);
  const normalized = message.toLowerCase();

  if (/no usable audio|too (short|quick)|hold the dictation key/.test(normalized)) {
    return {
      title: "That was too quick",
      detail: "Hold your push-to-talk shortcut while speaking, then release it when you are finished.",
    };
  }
  if (/no speech detected|silence|speech.*not detected/.test(normalized)) {
    return {
      title: "No speech detected",
      detail: "Try again a little closer to the microphone and speak at a normal volume.",
    };
  }
  if (/notallowederror|permission denied|microphone.*(denied|permission)|media access/.test(normalized)) {
    return {
      title: "Microphone access is off",
      detail: microphonePermissionRecovery(platform),
    };
  }
  if (/notfounderror|no microphone|audio input.*not found|requested device not found/.test(normalized)) {
    return {
      title: "Microphone unavailable",
      detail: "Choose another input from the microphone menu, then try again.",
    };
  }
  if (/notreadableerror|could not start audio source|device.*(busy|in use)/.test(normalized)) {
    return {
      title: "Microphone is busy",
      detail: "Close the other app using your microphone, then try again.",
    };
  }
  if (/recorder is not active|recording.*interrupted|invalidstateerror/.test(normalized)) {
    return {
      title: "Recording was interrupted",
      detail: "Try dictating again. LocalScribe has reset the recorder.",
    };
  }
  if (/model_not_installed|model.*not installed|speech model.*missing/.test(normalized)) {
    return {
      title: "Local model is not installed",
      detail: "Open Settings > Model & Performance and install the selected local model before dictating.",
    };
  }
  if (/model_not_loaded|model.*not (ready|loaded)|asr model.*not ready/.test(normalized)) {
    return {
      title: "Local model is not ready",
      detail: "Wait a moment and try again. If this repeats, open Settings > Model & Performance and recheck the selected local model.",
    };
  }
  if (/bundled python runtime.*missing/.test(normalized)) {
    return {
      title: "Speech engine is incomplete",
      detail: "Reinstall LocalScribe to restore its local speech components.",
    };
  }
  if (/model_checksum_failed|model.*verification failed|checksum/.test(normalized)) {
    return {
      title: "Local model is damaged",
      detail: "Open Settings > Model & Performance and repair the selected local model.",
    };
  }
  if (/worker.*(timed out|did not start|exited|not running)|speech engine.*(stopped|timeout)/.test(normalized)) {
    return {
      title: "Speech engine stopped",
      detail: "Try again. If this repeats, quit and reopen LocalScribe.",
    };
  }
  if (/invalid json|violated the local protocol|unexpected worker response|invalid.*(response|audio|media|data|state)/.test(normalized)) {
    return {
      title: "Dictation could not finish",
      detail: "The local speech engine returned an invalid response. Try again.",
    };
  }
  if (/recording is too (?:large|long)/.test(normalized)) {
    return {
      title: "Recording is too long",
      detail: "Finish the dictation sooner, then continue in a new recording.",
    };
  }

  return {
    title: "Dictation could not finish",
    detail: safeDetail(message),
  };
}

export function microphonePermissionRecovery(platform?: DictationErrorPlatform): string {
  if (platform === "darwin") {
    return "Allow LocalScribe in System Settings > Privacy & Security > Microphone.";
  }
  if (platform === "win32") {
    return "Allow LocalScribe in Windows Settings > Privacy & security > Microphone.";
  }
  return "Allow LocalScribe in your operating system's microphone privacy settings, then try again.";
}

function safeDetail(message: string): string {
  return message === FALLBACK_MESSAGE
    ? FALLBACK_DETAIL
    : rendererSafeErrorMessage(message, FALLBACK_DETAIL);
}
