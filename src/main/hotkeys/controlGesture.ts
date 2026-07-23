export interface ControlGestureCallbacks {
  onHoldStart: () => void;
  onHoldEnd: () => void;
  onToggle: () => void;
}

/**
 * Distinguishes a Control hold from the Control-Space toggle chord.
 * The short grace period is intentionally below a normal key-repeat delay.
 */
export class ControlGesture {
  private controlPressed = false;
  private holdStarted = false;
  private chordUsed = false;
  private toggleEmitted = false;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly callbacks: ControlGestureCallbacks,
    private readonly holdDelayMs = 160,
  ) {}

  controlDown(): void {
    if (this.controlPressed) return;
    this.controlPressed = true;
    // A native shortcut callback can arrive just before the lower-level hook.
    // Preserve that already-consumed chord instead of arming a late hold.
    if (this.chordUsed && this.toggleEmitted) return;
    this.holdStarted = false;
    this.chordUsed = false;
    this.toggleEmitted = false;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (!this.controlPressed || this.chordUsed) return;
      this.holdStarted = true;
      this.callbacks.onHoldStart();
    }, this.holdDelayMs);
  }

  spaceDown(emitToggle = true): void {
    if (!this.controlPressed || this.chordUsed || this.holdStarted) return;
    this.chordUsed = true;
    this.cancelHoldTimer();
    if (emitToggle) this.emitToggleOnce();
  }

  shortcutToggle(): void {
    if (this.holdStarted || this.toggleEmitted) return;
    this.chordUsed = true;
    this.cancelHoldTimer();
    this.emitToggleOnce();
  }

  modifiedInput(): void {
    if (!this.controlPressed || this.holdStarted) return;
    this.chordUsed = true;
    this.cancelHoldTimer();
  }

  controlUp(): void {
    if (!this.controlPressed && !this.chordUsed && !this.toggleEmitted) return;
    this.controlPressed = false;
    this.cancelHoldTimer();
    if (this.holdStarted) this.callbacks.onHoldEnd();
    this.holdStarted = false;
    this.chordUsed = false;
    this.toggleEmitted = false;
  }

  reset(): void {
    this.cancelHoldTimer();
    this.controlPressed = false;
    this.holdStarted = false;
    this.chordUsed = false;
    this.toggleEmitted = false;
  }

  private cancelHoldTimer(): void {
    if (this.holdTimer === null) return;
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  private emitToggleOnce(): void {
    if (this.toggleEmitted) return;
    this.toggleEmitted = true;
    this.callbacks.onToggle();
  }
}
