export interface HoldShortcutGestureCallbacks {
  onHoldStart: () => void;
  onHoldEnd: () => void;
}

/**
 * Distinguishes a configurable push-to-talk key from shortcuts that begin
 * with the same modifier. A short grace period lets the complete chord arrive.
 */
export class HoldShortcutGesture {
  private keyPressed = false;
  private holdStarted = false;
  private cancelled = false;
  private suppressUntilRelease = false;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly callbacks: HoldShortcutGestureCallbacks,
    private readonly holdDelayMs = 160,
  ) {}

  keyDown(): void {
    if (this.keyPressed) return;
    this.keyPressed = true;
    this.holdStarted = false;
    this.cancelled = this.suppressUntilRelease;
    if (this.cancelled) return;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (!this.keyPressed || this.cancelled) return;
      this.holdStarted = true;
      this.callbacks.onHoldStart();
    }, this.holdDelayMs);
  }

  modifiedInput(): void {
    if (!this.keyPressed || this.holdStarted) return;
    this.cancelled = true;
    this.cancelHoldTimer();
  }

  /**
   * Returns false when an active push-to-talk session owns the keyboard.
   * `overlapsHoldKey` handles Electron delivering a chord before uiohook.
   */
  prepareToggle(overlapsHoldKey: boolean): boolean {
    if (this.holdStarted) return false;
    this.cancelled = true;
    this.cancelHoldTimer();
    if (overlapsHoldKey) this.suppressUntilRelease = true;
    return true;
  }

  keyUp(): void {
    if (!this.keyPressed && !this.suppressUntilRelease) return;
    this.keyPressed = false;
    this.cancelHoldTimer();
    if (this.holdStarted) this.callbacks.onHoldEnd();
    this.holdStarted = false;
    this.cancelled = false;
    this.suppressUntilRelease = false;
  }

  reset(): void {
    this.cancelHoldTimer();
    this.keyPressed = false;
    this.holdStarted = false;
    this.cancelled = false;
    this.suppressUntilRelease = false;
  }

  get isHoldActive(): boolean {
    return this.holdStarted;
  }

  private cancelHoldTimer(): void {
    if (this.holdTimer === null) return;
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }
}
