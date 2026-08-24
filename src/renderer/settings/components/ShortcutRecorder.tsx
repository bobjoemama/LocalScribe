import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  holdShortcutSchema,
  shortcutDisplayLabel,
  toggleShortcutSchema,
} from "../../../shared/shortcuts";
import { rendererSafeErrorMessage } from "../../../shared/rendererErrors";

export type ShortcutKind = "hold" | "toggle";

export type ShortcutValidationOutcome = {
  accepted: boolean;
  shortcut?: string;
  error?: string;
  warning?: string;
};

/**
 * Should the recorder take focus back after a validation finishes?
 *
 * Extracted from the effect below so it can be exercised directly. There is no
 * DOM in this suite, and the source-shaped test that stood in for one was
 * tautological — it asserted that the word "orphaned" appeared in a slice that
 * *began* at the `const orphaned =` declaration, so it held no matter how the
 * guard was used, including when the guard was inverted or the focus call was
 * deleted. Taking the two elements as arguments makes the decision testable
 * without a document.
 *
 * Both halves matter and pull in opposite directions: without it a keyboard
 * user is dropped on `document.body` when the disabled button blurs, and with
 * it inverted the recorder yanks focus out of wherever the user deliberately
 * moved during validation.
 */
export function shouldRestoreRecorderFocus(input: {
  wasValidating: boolean;
  validating: boolean;
  activeElement: unknown;
  body: unknown;
}): boolean {
  // Only on the falling edge of a validation, never on an ordinary re-render.
  if (!input.wasValidating || input.validating) return false;
  // Only when nothing else holds focus.
  return input.activeElement === null || input.activeElement === input.body;
}

type ShortcutRecorderProps = {
  kind: ShortcutKind;
  label: string;
  detail: string;
  value: string;
  /** Commits through main; accepted values are already live and persisted. */
  onAccept(shortcut: string): Promise<ShortcutValidationOutcome>;
};

const modifierCodes = new Set([
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "ShiftLeft",
  "ShiftRight",
]);

type ShortcutKeyboardEvent = Pick<
  KeyboardEvent,
  "code" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey"
>;

/**
 * Creates an accelerator candidate from physical DOM key codes. Keeping this
 * based on `code` makes the recorded shortcut stable across keyboard layouts.
 */
export function shortcutFromKeyboardEvent(
  event: ShortcutKeyboardEvent,
): string | null {
  const modifiers = (["Control", "Alt", "Command", "Shift"] as const).filter((modifier) => {
        if (modifier === "Control") return event.ctrlKey;
        if (modifier === "Alt") return event.altKey;
        if (modifier === "Command") return event.metaKey;
        return event.shiftKey;
      });
  const key = shortcutTokenFromCode(event.code);
  const tokens = key && !modifierCodes.has(event.code) ? [...modifiers, key] : modifiers;
  return tokens.length ? tokens.join("+") : null;
}

function shortcutTokenFromCode(code: string): string | null {
  if (modifierCodes.has(code)) return null;
  if (code === "Space") return "Space";
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  if (code === "NumpadEnter") return "NumpadEnter";
  return code || null;
}

export function shortcutRecorderErrorMessage(error: unknown, fallback: string): string {
  return rendererSafeErrorMessage(error, fallback);
}

function readableShortcutLabel(shortcut: string): string {
  try {
    return shortcutDisplayLabel(shortcut);
  } catch {
    return shortcut;
  }
}

export function ShortcutRecorder({
  kind,
  label,
  detail,
  value,
  onAccept,
}: ShortcutRecorderProps) {
  const [capturing, setCapturing] = useState(false);
  const [validating, setValidating] = useState(false);
  const [liveShortcut, setLiveShortcut] = useState("");
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const captureId = useRef(0);
  const capturingRef = useRef(false);
  const startPromise = useRef<Promise<void> | null>(null);
  const lastShortcut = useRef("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasValidating = useRef(false);
  const descriptionId = useId();
  const feedbackId = useId();

  /*
   * Committing a recorded shortcut disables this button while main validates
   * it. Disabling the focused element blurs it, and the browser drops focus to
   * `document.body` — so a keyboard user who just recorded a shortcut lost
   * their place in the dialog entirely and had to tab back from the top.
   * Restore focus, but only when nothing else has claimed it: moving focus a
   * user has deliberately placed elsewhere would be worse than losing it.
   */
  useEffect(() => {
    const restore = shouldRestoreRecorderFocus({
      wasValidating: wasValidating.current,
      validating,
      activeElement: document.activeElement,
      body: document.body,
    });
    if (restore) buttonRef.current?.focus();
    wasValidating.current = validating;
  }, [validating]);

  const endNativeCapture = useCallback(async () => {
    const begin = startPromise.current;
    startPromise.current = null;
    try {
      await begin;
    } catch {
      // The visible message comes from the begin call; still release capture.
    }
    try {
      await window.localScribe.shortcuts.endCapture();
    } catch {
      // A best-effort release should not hide a validation or cancellation result.
    }
  }, []);

  const cancelCapture = useCallback((message?: string) => {
    if (!capturingRef.current) return;
    captureId.current += 1;
    capturingRef.current = false;
    lastShortcut.current = "";
    setCapturing(false);
    setLiveShortcut("");
    if (message) setError(message);
    void endNativeCapture();
  }, [endNativeCapture]);

  const finishCapture = useCallback(async (candidate: string) => {
    if (!capturingRef.current) return;
    const attempt = captureId.current;
    capturingRef.current = false;
    setCapturing(false);
    setValidating(true);
    await endNativeCapture();

    if (attempt !== captureId.current) return;
    const parsed = kind === "toggle"
      ? toggleShortcutSchema.safeParse(candidate)
      : holdShortcutSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "That key combination cannot be used as a shortcut.");
      setValidating(false);
      return;
    }
    const shortcut = parsed.data;

    try {
      const result = await onAccept(shortcut);
      if (attempt !== captureId.current) return;
      if (!result.accepted) {
        setError(shortcutRecorderErrorMessage(
          result.error,
          "That shortcut is unavailable. Choose another key combination.",
        ));
        setWarning("");
        setValidating(false);
        return;
      }
      const acceptedShortcut = result.shortcut ?? shortcut;
      setError("");
      setWarning(result.warning ?? "");
      setLiveShortcut(acceptedShortcut);
      setValidating(false);
    } catch (validationError) {
      if (attempt !== captureId.current) return;
      setWarning("");
      setError(shortcutRecorderErrorMessage(
        validationError,
        "The shortcut could not be applied. Try again.",
      ));
      setValidating(false);
    }
  }, [endNativeCapture, kind, onAccept]);

  useEffect(() => {
    if (!capturing) return;
    const consume = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      consume(event);
      if (event.code === "Escape") {
        cancelCapture("Shortcut recording cancelled.");
        return;
      }
      if (event.code === "Backspace") {
        lastShortcut.current = "";
        setLiveShortcut("");
        setError("");
        setWarning("");
        return;
      }
      if (event.repeat) return;
      const candidate = shortcutFromKeyboardEvent(event);
      if (!candidate) return;
      lastShortcut.current = candidate;
      setLiveShortcut(candidate);
      setError("");
      setWarning("");
    };
    const onKeyUp = (event: KeyboardEvent) => {
      consume(event);
      if (event.code === "Escape" || event.code === "Backspace") return;
      const candidate = lastShortcut.current;
      if (candidate) void finishCapture(candidate);
    };
    const onWindowBlur = () => cancelCapture("Shortcut recording cancelled when focus changed.");
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [cancelCapture, capturing, finishCapture]);

  useEffect(() => () => {
    if (capturingRef.current) cancelCapture();
  }, [cancelCapture]);

  const startCapture = () => {
    if (validating) return;
    if (capturingRef.current) {
      cancelCapture("Shortcut recording cancelled.");
      return;
    }
    captureId.current += 1;
    capturingRef.current = true;
    lastShortcut.current = "";
    setCapturing(true);
    setLiveShortcut("");
    setError("");
    setWarning("");
    const attempt = captureId.current;
    startPromise.current = window.localScribe.shortcuts.beginCapture().catch((captureError: unknown) => {
      if (captureId.current !== attempt) return;
      // Invalidate every key event already queued for this attempt before the
      // rejected promise reaches React's next render. Otherwise a keyup from
      // the failed native capture can still enter finishCapture with the same
      // attempt id and apply a shortcut that was never captured exclusively.
      captureId.current += 1;
      capturingRef.current = false;
      lastShortcut.current = "";
      setCapturing(false);
      setLiveShortcut("");
      setError(shortcutRecorderErrorMessage(
        captureError,
        "Shortcut recording could not start. Try again.",
      ));
    });
  };

  const displayedShortcut = capturing ? liveShortcut : value;
  const hasFeedback = Boolean(error || warning);

  return (
    <div className="ls-settings-row ls-shortcut-recorder" data-shortcut-kind={kind}>
      <span>
        <strong>{label}</strong>
        <small id={descriptionId}>{detail}</small>
        {capturing && <small className="ls-shortcut-recorder__recording-help">Press a shortcut. Escape cancels; Backspace clears.</small>}
        {hasFeedback && (
          <span className={error ? "ls-shortcut-recorder__feedback is-error" : "ls-shortcut-recorder__feedback"} id={feedbackId} role={error ? "alert" : "status"} aria-live="polite">
            {error || warning}
          </span>
        )}
      </span>
      <button
        ref={buttonRef}
        type="button"
        className={capturing ? "ls-shortcut-recorder__button is-capturing" : "ls-shortcut-recorder__button"}
        onClick={startCapture}
        onBlur={() => cancelCapture("Shortcut recording cancelled when focus changed.")}
        disabled={validating}
        aria-busy={validating || undefined}
        aria-pressed={capturing}
        aria-describedby={`${descriptionId}${hasFeedback ? ` ${feedbackId}` : ""}`}
        aria-label={capturing
          ? `${label}: recording. Press a shortcut, Escape to cancel, or Backspace to clear.`
          : `${label}: ${readableShortcutLabel(value)}. Activate to record a new shortcut.`}
      >
        <span className="ls-shortcut-recorder__key">
          {displayedShortcut
            ? readableShortcutLabel(displayedShortcut)
            : "Press a shortcut"}
        </span>
        <span className="ls-shortcut-recorder__action">
          {validating ? "Applying…" : capturing ? "Cancel" : "Record"}
        </span>
      </button>
    </div>
  );
}
