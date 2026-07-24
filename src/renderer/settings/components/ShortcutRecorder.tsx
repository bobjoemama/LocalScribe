import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  canonicalizeShortcut,
  shortcutDisplayLabel,
} from "../../../shared/shortcuts";

export type ShortcutKind = "hold" | "toggle";

export type ShortcutValidationOutcome = {
  accepted: boolean;
  shortcut?: string;
  error?: string;
  warning?: string;
};

type ShortcutRecorderProps = {
  kind: ShortcutKind;
  label: string;
  detail: string;
  value: string;
  /** Commits through main; accepted values are already live and persisted. */
  onAccept(shortcut: string): Promise<ShortcutValidationOutcome>;
};

const modifierCodes: Record<string, string> = {
  ControlLeft: "Control",
  ControlRight: "Control",
  AltLeft: "Alt",
  AltRight: "Alt",
  MetaLeft: "Command",
  MetaRight: "Command",
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
};

const modifierOrder = ["Control", "Alt", "Command", "Shift"] as const;

/**
 * Creates an accelerator candidate from physical DOM key codes. Keeping this
 * based on `code` makes the recorded shortcut stable across keyboard layouts.
 */
export function shortcutFromKeyboardEvent(event: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey">): string | null {
  const modifiers = modifierOrder.filter((modifier) => {
    if (modifier === "Control") return event.ctrlKey;
    if (modifier === "Alt") return event.altKey;
    if (modifier === "Command") return event.metaKey;
    return event.shiftKey;
  });
  const key = shortcutTokenFromCode(event.code);
  const tokens = key && !modifierCodes[event.code] ? [...modifiers, key] : modifiers;
  return tokens.length ? tokens.join("+") : null;
}

function shortcutTokenFromCode(code: string): string | null {
  if (modifierCodes[code]) return null;
  if (code === "Space") return "Space";
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  return code || null;
}

function readableError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
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
  const descriptionId = useId();
  const feedbackId = useId();

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
    let shortcut: string;
    try {
      shortcut = canonicalizeShortcut(candidate);
    } catch (captureError) {
      setError(readableError(captureError, "That key combination cannot be used as a shortcut."));
      setValidating(false);
      return;
    }

    try {
      const result = await onAccept(shortcut);
      if (attempt !== captureId.current) return;
      if (!result.accepted) {
        setError(result.error ?? "That shortcut is unavailable. Choose another key combination.");
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
      setError(readableError(validationError, "The shortcut could not be applied. Try again."));
      setValidating(false);
    }
  }, [endNativeCapture, onAccept]);

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
      capturingRef.current = false;
      setCapturing(false);
      setError(readableError(captureError, "Shortcut recording could not start. Try again."));
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
        <span className="ls-shortcut-recorder__key">{displayedShortcut ? readableShortcutLabel(displayedShortcut) : "Press a shortcut"}</span>
        <span className="ls-shortcut-recorder__action">{validating ? "Applying…" : capturing ? "Cancel" : "Record"}</span>
      </button>
    </div>
  );
}
