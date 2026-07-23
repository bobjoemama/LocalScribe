/**
 * Tracks an arbitrary set of physical key groups (for example left/right
 * Control count as the same logical Control key) and turns it into one hold
 * gesture. This stays independent from uiohook and Electron for direct tests.
 */
export interface HoldChordMatcherCallbacks {
  onChordStart(): void;
  onChordEnd(): void;
  onModifiedInput(): void;
}

export class HoldChordMatcher {
  private readonly pressed = new Set<number>();
  private chordMatched = false;
  private suppressedUntilRelease = false;

  constructor(
    private readonly requiredGroups: readonly (readonly number[])[],
    private readonly callbacks: HoldChordMatcherCallbacks,
    private readonly cancelPendingHoldOnExtraKey = false,
  ) {
    if (!requiredGroups.length) throw new Error("A hold shortcut needs at least one key.");
  }

  keyDown(keycode: number): void {
    if (this.pressed.has(keycode)) return;
    const hadRequiredKey = this.hasAnyRequiredKey();
    this.pressed.add(keycode);

    if (this.suppressedUntilRelease) return;
    if (
      this.cancelPendingHoldOnExtraKey &&
      hadRequiredKey &&
      !this.isRequiredKey(keycode)
    ) {
      this.modify();
      return;
    }
    if (this.matchesRequiredKeys()) {
      if (!this.chordMatched) {
        this.chordMatched = true;
        this.callbacks.onChordStart();
      }
      return;
    }

    if (hadRequiredKey && !this.isRequiredKey(keycode)) this.modify();
  }

  keyUp(keycode: number): void {
    const wasMatched = this.chordMatched;
    this.pressed.delete(keycode);
    if (wasMatched && !this.matchesRequiredKeys()) {
      this.chordMatched = false;
      this.suppressedUntilRelease = true;
      this.callbacks.onChordEnd();
    }
    if (!this.hasAnyRequiredKey()) this.suppressedUntilRelease = false;
  }

  mouseDown(): void {
    if (this.hasAnyRequiredKey()) this.modify();
  }

  reset(): void {
    this.pressed.clear();
    this.chordMatched = false;
    this.suppressedUntilRelease = false;
  }

  private modify(): void {
    this.suppressedUntilRelease = true;
    this.callbacks.onModifiedInput();
  }

  private matchesRequiredKeys(): boolean {
    return this.requiredGroups.every((group) => group.some((keycode) => this.pressed.has(keycode)));
  }

  private hasAnyRequiredKey(): boolean {
    return this.requiredGroups.some((group) => group.some((keycode) => this.pressed.has(keycode)));
  }

  private isRequiredKey(keycode: number): boolean {
    return this.requiredGroups.some((group) => group.includes(keycode));
  }
}
