import { globalShortcut } from "electron";
import { uIOhook, UiohookKey, type UiohookKeyboardEvent, type UiohookMouseEvent } from "uiohook-napi";
import {
  isModifierOnlyShortcut,
  parseShortcut,
  shortcutKindValidationError,
  shortcutsUseSamePhysicalKeys,
  shortcutTokens,
  toggleUsesHoldKey,
  type HoldShortcut,
  type ShortcutValidationRequest,
  type ShortcutValidationResult,
  type ToggleShortcut,
} from "../../shared/shortcuts";
import { HoldChordMatcher } from "./holdChordMatcher";
import { HoldShortcutGesture } from "./holdShortcutGesture";
import type { ControlMonitor, ControlMonitorEvent } from "./macControlMonitor";

type HotkeyMode = "stopped" | "full" | "fallback";

const CAPTURE_TIMEOUT_MS = 20_000;

const KEY_GROUPS: Record<string, readonly (readonly number[])[]> = {
  Space: [[UiohookKey.Space]],
  Tab: [[UiohookKey.Tab]],
  Backspace: [[UiohookKey.Backspace]],
  Delete: [[UiohookKey.Delete]],
  Insert: [[UiohookKey.Insert]],
  Return: [[UiohookKey.Enter]],
  Enter: [[UiohookKey.Enter]],
  Escape: [[UiohookKey.Escape]],
  Up: [[UiohookKey.ArrowUp]],
  Down: [[UiohookKey.ArrowDown]],
  Left: [[UiohookKey.ArrowLeft]],
  Right: [[UiohookKey.ArrowRight]],
  Home: [[UiohookKey.Home]],
  End: [[UiohookKey.End]],
  PageUp: [[UiohookKey.PageUp]],
  PageDown: [[UiohookKey.PageDown]],
  CapsLock: [[UiohookKey.CapsLock]],
  NumLock: [[UiohookKey.NumLock]],
  ScrollLock: [[UiohookKey.ScrollLock]],
  PrintScreen: [[UiohookKey.PrintScreen]],
  Minus: [[UiohookKey.Minus]],
  Equal: [[UiohookKey.Equal]],
  Comma: [[UiohookKey.Comma]],
  Period: [[UiohookKey.Period]],
  Slash: [[UiohookKey.Slash]],
  Semicolon: [[UiohookKey.Semicolon]],
  Quote: [[UiohookKey.Quote]],
  Backquote: [[UiohookKey.Backquote]],
  BracketLeft: [[UiohookKey.BracketLeft]],
  BracketRight: [[UiohookKey.BracketRight]],
  Backslash: [[UiohookKey.Backslash]],
  // A physical plus is Shift+Equal on the common layouts uiohook exposes.
  Plus: [[UiohookKey.Shift, UiohookKey.ShiftRight], [UiohookKey.Equal]],
  numdec: [[UiohookKey.NumpadDecimal]],
  numadd: [[UiohookKey.NumpadAdd]],
  numsub: [[UiohookKey.NumpadSubtract]],
  nummult: [[UiohookKey.NumpadMultiply]],
  numdiv: [[UiohookKey.NumpadDivide]],
  NumpadEnter: [[UiohookKey.NumpadEnter]],
};

function modifierKeyGroups(token: string, platform: NodeJS.Platform): readonly (readonly number[])[] | null {
  switch (token) {
    case "Control":
      return [[UiohookKey.Ctrl, UiohookKey.CtrlRight]];
    case "Command":
    case "Super":
    case "Meta":
      return [[UiohookKey.Meta, UiohookKey.MetaRight]];
    case "CommandOrControl":
      return platform === "darwin"
        ? [[UiohookKey.Meta, UiohookKey.MetaRight]]
        : [[UiohookKey.Ctrl, UiohookKey.CtrlRight]];
    case "Alt":
      return [[UiohookKey.Alt, UiohookKey.AltRight]];
    case "AltGr":
      return [[UiohookKey.AltRight]];
    case "Shift":
      return [[UiohookKey.Shift, UiohookKey.ShiftRight]];
    default:
      return null;
  }
}

function keyboardKeyGroups(token: string): readonly (readonly number[])[] | null {
  if (KEY_GROUPS[token]) return KEY_GROUPS[token];
  if (/^[A-Z]$/.test(token) || /^[0-9]$/.test(token) || /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(token)) {
    const keycode = UiohookKey[token as keyof typeof UiohookKey];
    return typeof keycode === "number" ? [[keycode]] : null;
  }
  if (/^num[0-9]$/.test(token)) {
    const keycode = UiohookKey[`Numpad${token.slice(3)}` as keyof typeof UiohookKey];
    return typeof keycode === "number" ? [[keycode]] : null;
  }
  return null;
}

/**
 * Maps the keyboard accelerator grammar accepted by `parseShortcut` to uiohook
 * physical-key groups. Exported for direct unit tests; callers should pass a
 * canonical shortcut or allow `parseShortcut` to canonicalize it.
 */
export function uiohookHoldKeyGroups(
  shortcut: string,
  platform: NodeJS.Platform = process.platform,
): readonly (readonly number[])[] {
  const groups = shortcutTokens(shortcut).flatMap((token) =>
    modifierKeyGroups(token, platform) ?? keyboardKeyGroups(token) ?? [],
  );
  if (!groups.length) throw new Error(`Unsupported hold shortcut: ${shortcut}.`);
  const seen = new Set<string>();
  return groups.filter((group) => {
    const key = [...group].sort((left, right) => left - right).join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class HotkeyService {
  private mode: HotkeyMode = "stopped";
  private toggleRegistered = false;
  /**
   * A failed registration is remembered for the current run. This prevents a
   * saved, now-conflicting shortcut from making startup fail repeatedly while
   * the app falls back from Accessibility to the native hold monitor.
   */
  private toggleRegistrationFailure: string | null = null;
  private toggleLocked = false;
  private toggleTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackMonitorStarted = false;
  private captureActive = false;
  private captureSuspended = false;
  private captureTimer: ReturnType<typeof setTimeout> | null = null;
  private holdMatcher: HoldChordMatcher;
  private readonly gesture: HoldShortcutGesture;

  constructor(
    onPress: () => void,
    onRelease: () => void,
    private readonly onToggle: () => void,
    private readonly fallbackMonitor: ControlMonitor | null,
    private holdShortcut: HoldShortcut,
    private toggleShortcut: ToggleShortcut,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.gesture = new HoldShortcutGesture({
      onHoldStart: onPress,
      onHoldEnd: onRelease,
    });
    this.holdMatcher = this.createHoldMatcher(holdShortcut);
  }

  start(): void {
    if (this.nativeMacMonitorSupports(this.holdShortcut)) {
      if (this.mode === "full") this.stopForReconfigure(true);
      this.startFallbackMode(false);
      return;
    }
    this.startFull(false);
  }

  /**
   * Reports only a hook that this service started successfully. On macOS this
   * includes the permission-free native hold monitor.
   */
  isGlobalHoldReady(): boolean {
    return this.mode === "full" || this.fallbackMonitorStarted;
  }

  /**
   * Did the toggle accelerator actually get registered?
   *
   * `start()` deliberately does not throw when it cannot claim the toggle — a
   * shortcut another app took while LocalScribe was closed must not stop
   * push-to-talk from working. But the failure then went nowhere: it was stored
   * privately, `console.warn`ed to a stdout that is /dev/null in the packaged
   * app, and `start()` returned normally, so main recorded the startup as
   * `hotkey/global_register: ok`. Meanwhile the tray menu still displayed the
   * accelerator and Settings still advised the user to "use the toggle
   * shortcut". Pressing it did nothing, with no surface anywhere reporting why.
   *
   * Neither existing signal covers this: `isGlobalHoldReady` is about the hold
   * key's hook, and is true in exactly the situation where the toggle is dead.
   */
  isToggleReady(): boolean {
    return this.toggleRegistered;
  }

  /**
   * Why the toggle is unavailable, or null when it is fine.
   *
   * Deliberately not routed into diagnostics: the message can embed an error
   * string from `globalShortcut.register`. Diagnostics gets a code; this is for
   * the user's own screen.
   */
  toggleUnavailableReason(): string | null {
    return this.toggleRegistered ? null : this.toggleRegistrationFailure;
  }

  private startFull(requireToggle: boolean): void {
    if (this.mode === "full") return;
    if (this.mode === "fallback") {
      // The fallback listener cannot deliver the eventual key-up after it is
      // removed. Resetting here releases any active push-to-talk session before
      // rare-key full-hook startup.
      this.stopForReconfigure(true);
    } else {
      this.stopFallbackMonitor();
    }
    this.registerToggle(requireToggle);
    let downListener = false;
    let upListener = false;
    let mouseListener = false;
    try {
      uIOhook.on("keydown", this.handleDown);
      downListener = true;
      uIOhook.on("keyup", this.handleUp);
      upListener = true;
      uIOhook.on("mousedown", this.handleMouseDown);
      mouseListener = true;
      uIOhook.start();
      this.mode = "full";
    } catch (error) {
      for (const [registered, event, listener] of [
        [downListener, "keydown", this.handleDown],
        [upListener, "keyup", this.handleUp],
        [mouseListener, "mousedown", this.handleMouseDown],
      ] as const) {
        if (!registered) continue;
        try {
          uIOhook.off(event, listener);
        } catch (cleanupError) {
          console.error(`Could not remove failed ${event} hotkey listener`, cleanupError);
        }
      }
      this.holdMatcher.reset();
      this.gesture.reset();
      this.mode = "stopped";
      throw error;
    }
  }

  startFallback(): void {
    if (this.mode === "full") {
      // Accessibility can be revoked while the app is running. Give up the
      // rare-key full hook and retain the registered toggle while falling back.
      this.stopForReconfigure(true);
    }
    this.startFallbackMode(false);
  }

  private startFallbackMode(requireToggle: boolean): void {
    if (this.mode === "full") return;
    const enteringFallback = this.mode !== "fallback";
    if (enteringFallback) this.registerToggle(requireToggle);
    if (this.platform !== "darwin") {
      if (enteringFallback) console.warn(
        `${this.holdShortcut} push-to-talk is unavailable because the ${this.platformLabel()} global keyboard hook could not start`,
      );
      this.mode = "fallback";
      return;
    }
    if (this.nativeMacMonitorSupports(this.holdShortcut) && !this.fallbackMonitorStarted) {
      try {
        this.fallbackMonitorStarted = this.fallbackMonitor?.start(
          this.holdShortcut,
          this.handleMonitorEvent,
          this.handleFallbackMonitorStopped,
        ) ?? false;
      } catch (error) {
        this.fallbackMonitorStarted = false;
        if (enteringFallback) console.warn(
          `${this.holdShortcut} push-to-talk is unavailable because the native key-state monitor could not start`,
          error,
        );
      }
      if (!this.fallbackMonitorStarted && enteringFallback) {
        console.warn(
          `${this.holdShortcut} push-to-talk is unavailable because the native key-state monitor could not start`,
        );
      }
    } else if (!this.nativeMacMonitorSupports(this.holdShortcut) && enteringFallback) {
      console.warn(`${this.holdShortcut} push-to-talk requires Accessibility on macOS`);
    }
    this.mode = "fallback";
  }

  reconfigure(holdShortcut: HoldShortcut, toggleShortcut: ToggleShortcut): void {
    const canonicalHold = parseShortcut(holdShortcut).canonical;
    const canonicalToggle = parseShortcut(toggleShortcut).canonical;
    if (this.captureActive) throw new Error("Finish recording the shortcut before saving it.");
    if (shortcutsUseSamePhysicalKeys(canonicalHold, canonicalToggle, this.platform)) {
      throw new Error("Push-to-talk and toggle dictation must use different shortcuts.");
    }

    if (canonicalHold === this.holdShortcut && canonicalToggle === this.toggleShortcut) {
      // A user deliberately saving an unchanged shortcut is the one safe time
      // to retry a registration that was unavailable at app startup.
      if (!this.toggleRegistered && this.toggleRegistrationFailure) {
        this.toggleRegistrationFailure = null;
        this.registerToggle(true);
      }
      return;
    }
    if (
      this.mode === "fallback"
      && this.platform !== "darwin"
      && canonicalHold !== this.holdShortcut
    ) {
      throw new Error(
        `${this.platformLabel()} push-to-talk cannot be changed because the global keyboard hook did not start. Toggle dictation remains available.`,
      );
    }

    // Build before touching live registration so an unsupported hold cannot
    // interrupt a currently working shortcut configuration.
    const nextMatcher = this.createHoldMatcher(canonicalHold);
    // Probe the OS before unregistering the working shortcut. The final
    // registration below remains authoritative because another app can claim
    // the key in the small interval between this probe and the swap.
    this.assertToggleCanRegister(canonicalToggle);
    const previous = {
      holdShortcut: this.holdShortcut,
      toggleShortcut: this.toggleShortcut,
      mode: this.mode,
    };
    // A hold-only change does not need to give up a working global toggle.
    // Keeping it registered removes an avoidable race with another app.
    const preserveToggleRegistration = this.toggleRegistered && canonicalToggle === previous.toggleShortcut;

    this.stopForReconfigure(preserveToggleRegistration);
    this.holdShortcut = canonicalHold;
    this.toggleShortcut = canonicalToggle;
    this.holdMatcher = nextMatcher;
    try {
      this.startMode(previous.mode, true);
    } catch (error) {
      this.stopForReconfigure(preserveToggleRegistration);
      this.holdShortcut = previous.holdShortcut;
      this.toggleShortcut = previous.toggleShortcut;
      this.holdMatcher = this.createHoldMatcher(previous.holdShortcut);
      try {
        this.startMode(previous.mode, true);
      } catch (rollbackError) {
        console.error("Could not restore the previous LocalScribe shortcuts", rollbackError);
      }
      throw error;
    }
  }

  /** Ignore keyboard input while a renderer records a new shortcut. */
  beginCapture(): void {
    if (this.captureActive) return;
    this.captureActive = true;
    this.holdMatcher.reset();
    this.gesture.reset();
    try {
      // Set this before calling Electron so the catch path will always make a
      // best-effort attempt to resume shortcuts, even on an unusual partial
      // native failure.
      this.captureSuspended = true;
      globalShortcut.setSuspended(true);
      this.captureTimer = setTimeout(() => this.endCapture(), CAPTURE_TIMEOUT_MS);
      this.captureTimer.unref();
    } catch (error) {
      // Do not leave a failed capture in a state where later key presses are ignored.
      this.captureActive = false;
      if (this.captureTimer) clearTimeout(this.captureTimer);
      this.captureTimer = null;
      this.resumeShortcutsAfterCapture();
      throw error;
    }
  }

  /** Always safe to call from an IPC `finally` block. */
  endCapture(): void {
    if (!this.captureActive && !this.captureSuspended) return;
    this.captureActive = false;
    if (this.captureTimer) clearTimeout(this.captureTimer);
    this.captureTimer = null;
    this.holdMatcher.reset();
    this.gesture.reset();
    this.resumeShortcutsAfterCapture();
  }

  validateShortcut(input: ShortcutValidationRequest): ShortcutValidationResult {
    let shortcut: string;
    let otherShortcut: string | undefined;
    let parsedShortcut: ReturnType<typeof parseShortcut>;
    try {
      parsedShortcut = parseShortcut(input.shortcut);
      shortcut = parsedShortcut.canonical;
      otherShortcut = input.otherShortcut === undefined ? undefined : parseShortcut(input.otherShortcut).canonical;
    } catch (error) {
      return {
        shortcut: input.shortcut,
        available: false,
        error: error instanceof Error ? error.message : "Invalid shortcut.",
      };
    }

    if (otherShortcut && shortcutsUseSamePhysicalKeys(shortcut, otherShortcut, this.platform)) {
      return {
        shortcut,
        available: false,
        error: "Push-to-talk and toggle dictation must use different shortcuts.",
      };
    }
    if (input.kind === "toggle" && isModifierOnlyShortcut(shortcut)) {
      return {
        shortcut,
        available: false,
        error: `Toggle dictation needs a non-modifier key so ${this.platformLabel()} can register it.`,
      };
    }
    const kindError = shortcutKindValidationError(input.kind, parsedShortcut);
    if (kindError) {
      return {
        shortcut,
        available: false,
        error: kindError,
      };
    }
    if (input.kind === "hold" && this.mode === "fallback" && this.platform !== "darwin") {
      return {
        shortcut,
        available: false,
        error: `${this.platformLabel()} push-to-talk is unavailable because the global keyboard hook did not start. Toggle dictation remains available.`,
      };
    }
    if (
      input.kind === "hold"
      && this.mode === "fallback"
      && this.platform === "darwin"
      && !this.nativeMacMonitorSupports(shortcut)
    ) {
      return {
        shortcut,
        available: false,
        error: `${shortcut} push-to-talk requires Accessibility on macOS.`,
      };
    }
    if (this.captureActive || globalShortcut.isSuspended()) {
      return {
        shortcut,
        available: false,
        error: "Finish recording the shortcut before checking availability.",
      };
    }
    // Electron has no distinct Numpad Enter accelerator token. Hold-to-talk
    // does not need Electron: uiohook exposes its physical keypad keycode.
    if (input.kind === "hold" && parsedShortcut.key === "NumpadEnter") {
      try {
        uiohookHoldKeyGroups(shortcut, this.platform);
        return { shortcut, available: true };
      } catch (error) {
        return {
          shortcut,
          available: false,
          error: error instanceof Error ? error.message : "Numpad Enter is unavailable for push-to-talk.",
        };
      }
    }
    // Modifier-only hold chords are handled by the keyboard hook. Unlike an
    // Electron global accelerator, there is no reliable system-wide probe to
    // perform, so do not turn a valid choice into an error-like warning.
    if (input.kind === "hold" && isModifierOnlyShortcut(shortcut)) return { shortcut, available: true };
    // The currently registered LocalScribe toggle is already known to be ours.
    if (this.toggleRegistered && shortcut === this.toggleShortcut) {
      return { shortcut, available: true };
    }

    let temporarilyRegistered = false;
    try {
      temporarilyRegistered = globalShortcut.register(shortcut, () => undefined);
      if (!temporarilyRegistered) {
        return {
          shortcut,
          available: false,
          error: `This shortcut is already used by ${this.platformLabel()} or another app.`,
        };
      }
      return { shortcut, available: true };
    } catch (error) {
      return {
        shortcut,
        available: false,
        error: error instanceof Error ? error.message : "This shortcut could not be registered.",
      };
    } finally {
      if (temporarilyRegistered) globalShortcut.unregister(shortcut);
    }
  }

  stop(): void {
    this.stopForReconfigure(false);
  }

  private stopForReconfigure(preserveToggleRegistration: boolean): void {
    this.endCapture();
    let firstFailure: unknown;
    const rememberFailure = (error: unknown) => {
      firstFailure ??= error;
    };
    if (this.mode === "full") {
      for (const [event, listener] of [
        ["keydown", this.handleDown],
        ["keyup", this.handleUp],
        ["mousedown", this.handleMouseDown],
      ] as const) {
        try {
          uIOhook.off(event, listener);
        } catch (error) {
          rememberFailure(error);
        }
      }
      try {
        uIOhook.stop();
      } catch (error) {
        rememberFailure(error);
      }
    }
    this.mode = "stopped";
    this.holdMatcher.reset();
    this.gesture.reset();
    try {
      this.stopFallbackMonitor();
    } catch (error) {
      rememberFailure(error);
    }
    this.clearToggleLock();
    if (!preserveToggleRegistration) {
      if (this.toggleRegistered) {
        try {
          globalShortcut.unregister(this.toggleShortcut);
        } catch (error) {
          rememberFailure(error);
        }
      }
      this.toggleRegistered = false;
      this.toggleRegistrationFailure = null;
    }
    if (firstFailure) throw firstFailure;
  }

  private readonly handleDown = (event: UiohookKeyboardEvent): void => {
    if (this.captureActive) return;
    this.holdMatcher.keyDown(event.keycode);
  };

  private readonly handleUp = (event: UiohookKeyboardEvent): void => {
    if (this.captureActive) return;
    this.holdMatcher.keyUp(event.keycode);
  };

  private readonly handleMouseDown = (_event: UiohookMouseEvent): void => {
    if (this.captureActive) return;
    this.holdMatcher.mouseDown();
  };

  private readonly handleMonitorEvent = (event: ControlMonitorEvent): void => {
    if (this.captureActive || this.mode === "full") return;
    if (event === "hold-down") this.gesture.keyDown();
    else if (event === "hold-up") this.gesture.keyUp();
    else this.gesture.modifiedInput();
  };

  private readonly handleFallbackMonitorStopped = (): void => {
    if (!this.fallbackMonitorStarted) return;
    this.fallbackMonitorStarted = false;
    // A dead helper cannot deliver key-up. End a hold that already began and
    // let the periodic macOS permission reconciler retry the monitor later.
    this.gesture.reset();
  };

  private readonly handleToggle = (): void => {
    if (this.captureActive) return;
    if (!this.gesture.prepareToggle(toggleUsesHoldKey(this.toggleShortcut, this.holdShortcut, this.platform))) return;
    if (this.toggleLocked) return;
    this.toggleLocked = true;
    this.onToggle();
    this.toggleTimer = setTimeout(() => this.clearToggleLock(), 600);
  };

  private createHoldMatcher(shortcut: string): HoldChordMatcher {
    return new HoldChordMatcher(
      uiohookHoldKeyGroups(shortcut, this.platform),
      {
        onChordStart: () => this.gesture.keyDown(),
        onChordEnd: () => this.gesture.keyUp(),
        onModifiedInput: () => this.gesture.modifiedInput(),
      },
      // A modifier-only hold is intentionally delayed so the user can still
      // use that modifier in another shortcut. Once every modifier is down,
      // the matcher must continue watching for a non-required key: otherwise
      // Command+Control+A can start dictation after the grace period on macOS.
      // Windows already needs this behavior for its modifier holds.
      this.platform === "win32" || (this.platform === "darwin" && isModifierOnlyShortcut(shortcut)),
    );
  }

  /**
   * Register the toggle exactly once for normal startup. A persisted shortcut
   * may become occupied while the app is not running; in that case keep
   * push-to-talk usable and tell the user how to fix it instead of crashing or
   * retrying during fallback setup. Reconfiguration passes `true` so its final
   * post-probe registration failure remains a transactional error.
   */
  private registerToggle(requireToggle: boolean): boolean {
    if (this.toggleRegistered) return true;
    if (this.toggleRegistrationFailure) {
      if (requireToggle) throw new Error(this.toggleRegistrationFailure);
      return false;
    }

    let registered = false;
    let failure: string | null = null;
    try {
      registered = globalShortcut.register(this.toggleShortcut, this.handleToggle);
      if (!registered) failure = this.toggleUnavailableMessage(this.toggleShortcut);
    } catch (error) {
      failure = this.toggleUnavailableMessage(this.toggleShortcut, error);
    }

    if (registered) {
      this.toggleRegistered = true;
      return true;
    }

    this.toggleRegistrationFailure = failure ?? this.toggleUnavailableMessage(this.toggleShortcut);
    if (requireToggle) throw new Error(this.toggleRegistrationFailure);
    console.warn(this.toggleRegistrationFailure);
    return false;
  }

  private assertToggleCanRegister(shortcut: string): void {
    // We already own this exact active accelerator. Registering it again would
    // always report a false conflict, so preserve it until the swap.
    if (this.toggleRegistered && shortcut === this.toggleShortcut) return;

    let temporarilyRegistered = false;
    try {
      temporarilyRegistered = globalShortcut.register(shortcut, () => undefined);
      if (!temporarilyRegistered) throw new Error(this.toggleUnavailableMessage(shortcut));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Toggle dictation is unavailable")) throw error;
      throw new Error(this.toggleUnavailableMessage(shortcut, error), { cause: error });
    } finally {
      if (temporarilyRegistered) globalShortcut.unregister(shortcut);
    }
  }

  private toggleUnavailableMessage(shortcut: string, error?: unknown): string {
    const detail = error instanceof Error && error.message
      ? ` (${error.message})`
      : "";
    return `Toggle dictation is unavailable because ${shortcut} is already used by ${this.platformLabel()} or another app${detail}. Choose another toggle shortcut in Settings.`;
  }

  private platformLabel(): string {
    if (this.platform === "darwin") return "macOS";
    if (this.platform === "win32") return "Windows";
    return "the operating system";
  }

  private resumeShortcutsAfterCapture(): void {
    if (!this.captureSuspended) return;
    this.captureSuspended = false;
    try {
      globalShortcut.setSuspended(false);
    } catch (error) {
      // The service state must still be released so a later capture/stop can
      // recover. Electron failures here are surfaced in the main-process log.
      console.error("Could not resume shortcuts after recording a shortcut", error);
    }
  }

  private clearToggleLock(): void {
    if (this.toggleTimer) clearTimeout(this.toggleTimer);
    this.toggleTimer = null;
    this.toggleLocked = false;
  }

  private stopFallbackMonitor(): void {
    if (!this.fallbackMonitorStarted) return;
    this.fallbackMonitorStarted = false;
    this.fallbackMonitor?.stop();
  }

  private startMode(mode: HotkeyMode, requireToggle: boolean): void {
    if (this.nativeMacMonitorSupports(this.holdShortcut)) {
      this.startFallbackMode(requireToggle);
    } else if (mode === "full") this.startFull(requireToggle);
    else if (mode === "fallback") this.startFallbackMode(requireToggle);
  }

  private nativeMacMonitorSupports(shortcut: string): boolean {
    return this.platform === "darwin" && (this.fallbackMonitor?.supports(shortcut) ?? false);
  }
}
