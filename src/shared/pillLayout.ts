import type { AsrMode, DictationActivation, PillMode, SessionState } from "./contracts";
import { ERROR_NOTICE_DURATION_MS } from "./dictationErrors";

export interface PillSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Widest measured status string, and the fixed chrome around it. Produced by
 * `scripts/measure-pill-status-widths.mjs`; see `PILL_LAYOUT.status`.
 */
export const STATUS_COPY_WIDTH = 143;
export const STATUS_CHROME_WIDTH = 8 + 6 + 22 + 22 + 7 + 7;

/**
 * The transparent native window and the renderer must agree on these bounds.
 * Keep the window-facing sizes here instead of duplicating magic dimensions in
 * the main process and the pill stylesheet.
 */
export const PILL_LAYOUT = {
  idle: {
    collapsed: { width: 40, height: 8 },
    /*
     * Wide enough for the tooltips the pill shows in ordinary use.
     *
     * The tooltip box is `hover.width - 9`, with 10px of padding each side, so
     * this width minus 29 is all the text ever gets. At 146 that was 117px, and
     * measured in Chromium at the shipped 11px/600 type
     * (`scripts/measure-pill-tooltip-widths.mjs`) the three tooltips a working
     * install actually shows are wider than that: "Dictate · hold ⌥Space"
     * 118.8px, "Dictate · hold ⌃⌥⌘F13" 124.5px, "Close microphone menu"
     * 129.8px. The shortcut hint is the thing the idle pill exists to teach, and
     * it was the thing being cut off.
     *
     * 159 = 129.8 rounded up, plus the 20px of padding and the 9px the box
     * gives back. The remaining seven strings are loading/unavailable states
     * that no healthy install shows; they still overflow and still ellipsise.
     *
     * The picker is already 210 wide, so nothing outside this window's own
     * hover size changes.
     */
    hover: { width: 159, height: 64 },
    picker: { width: 210, height: 212 },
  },
  listening: {
    hold: { width: 76, height: 26 },
    toggle: { width: 100, height: 32 },
  },
  /*
   * Live recognizers publish a revisable transcript while recording. The
   * native window cannot resize on each revision without sliding under a
   * stationary pointer, so reserve one fixed, readable line only for those
   * Live sessions. Final-only dictation keeps its compact original bounds.
   */
  liveListening: {
    hold: { width: 236, height: 26 },
    toggle: { width: 280, height: 32 },
  },
  /*
   * Wide enough for the longest status the product can show.
   *
   * At 128px the copy area was 56px — about ten characters — so every ordinary
   * dictation read "Transcribin…", and "Copied — allow Accessibility", the one
   * signal that automatic paste degraded to clipboard-only, was unreadable.
   * Measured in Chromium at the shipped 10px/600 type by
   * `scripts/measure-pill-status-widths.mjs`: the widest message
   * ("Copied — allow Accessibility") is 143px, and the surrounding chrome
   * (14px padding + 22px mark + 22px close + two 7px gaps) is 72px.
   *
   * The width is fixed rather than per-message: the pill is centred on the
   * work area, so a width that tracked the text would slide the window
   * sideways under a stationary pointer on every status change.
   */
  status: { width: STATUS_COPY_WIDTH + STATUS_CHROME_WIDTH, height: 32 },
  error: {
    stack: { width: 336, height: 100 },
    notice: { width: 328, minHeight: 82 },
  },
  rail: { width: 39, height: 7 },
  pickerMenuHeight: 210,
} as const satisfies {
  idle: Record<PillMode, PillSize>;
  listening: Record<DictationActivation, PillSize>;
  liveListening: Record<DictationActivation, PillSize>;
  status: PillSize;
  error: {
    stack: PillSize;
    notice: { readonly width: number; readonly minHeight: number };
  };
  rail: PillSize;
  pickerMenuHeight: number;
};

/**
 * Listening-waveform bar geometry.
 *
 * The bars render at `maxHeight` and are scaled, never resized: a level
 * arrives every 32ms, and animating a layout property that often reflowed the
 * pill on every frame of every recording. Both the stylesheet and the scale
 * below read these numbers, so the rendered height and the scale that divides
 * it cannot drift apart — if they did the waveform would silently render at
 * the wrong amplitude, which no layout assertion would catch.
 */
export const PILL_WAVE_BAR = {
  /** Height of a bar at silence. Keeps a visible resting line. */
  minHeight: 2,
  /** Height of a bar at full scale, and the unscaled height of every bar. */
  maxHeight: 19,
  /** Below 1, so quiet speech is still legible against loud speech. */
  exponent: 0.72,
} as const;

/**
 * Vertical scale for a waveform bar at `sample`, in 0..1.
 *
 * The level is clamped first: `Math.pow` of a negative base with a fractional
 * exponent is NaN, and a NaN transform silently drops the bar rather than
 * failing anywhere visible.
 */
export function pillWaveBarScale(sample: number): number {
  const level = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
  const span = PILL_WAVE_BAR.maxHeight - PILL_WAVE_BAR.minHeight;
  const height = Math.round(PILL_WAVE_BAR.minHeight + Math.pow(level, PILL_WAVE_BAR.exponent) * span);
  return height / PILL_WAVE_BAR.maxHeight;
}

export const PILL_WINDOW_BOTTOM_MARGIN = 8;
export const PILL_HOVER_HIT_PADDING = 10;

export interface PillRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PillPoint {
  readonly x: number;
  readonly y: number;
}

function contains(rect: PillRect, point: PillPoint, padding: number): boolean {
  return point.x >= rect.x - padding
    && point.x < rect.x + rect.width + padding
    && point.y >= rect.y - padding
    && point.y < rect.y + rect.height + padding;
}

/**
 * Decides the collapsed/hover size of the transparent pill window from the
 * pointer position alone. The renderer still owns when expanded controls become
 * visible; this only decides how much screen the mouse-opaque window may claim.
 *
 * Two rules, and they have to agree or the window latches open:
 *
 *  - Expanding uses `PILL_HOVER_HIT_PADDING`, because the collapsed rail is
 *    40x8 and needs a forgiving target — but only where the expanded window
 *    will actually sit under the pointer. The expanded window is bottom
 *    anchored, so padding below its bottom edge is exactly the region it will
 *    not cover.
 *  - Contracting requires the pointer to be outside the live window with no
 *    padding at all.
 *
 * Without the first rule, leaving the pill downward toward the Dock left a
 * 159x64 invisible, always-on-top, mouse-opaque window parked over whatever was
 * behind it: the renderer had already collapsed on `pointerleave`, so nothing
 * drew and nothing asked for a contraction, while the poller kept re-expanding
 * from the pad below the bottom edge. Without the second rule, the same padding
 * would expand and contract on alternating 75ms ticks.
 */
export function pillHoverModeForPointer(input: {
  readonly mode: PillMode;
  readonly cursor: PillPoint;
  readonly windowBounds: PillRect;
  readonly hoverBounds: PillRect;
  readonly padding?: number;
}): PillMode {
  const padding = input.padding ?? PILL_HOVER_HIT_PADDING;
  if (input.mode === "collapsed") {
    const near = contains(input.windowBounds, input.cursor, padding);
    return near && contains(input.hoverBounds, input.cursor, 0) ? "hover" : "collapsed";
  }
  if (input.mode === "hover") {
    return contains(input.windowBounds, input.cursor, 0) ? "hover" : "collapsed";
  }
  // The picker is renderer-driven: it stays open until the renderer closes it.
  return input.mode;
}

/**
 * What the renderer's visual mode becomes when main reports the size it just
 * committed for the transparent window.
 *
 * Main resizes from the real cursor position, which the renderer cannot see,
 * and a window that changes size under a stationary pointer produces no
 * pointerenter/pointerleave. So the renderer has to be told, or it keeps the
 * expanded controls mounted and clipped inside the 40x8 rail — most visibly
 * right after a microphone is chosen, with the pointer still where the 212px
 * picker used to be.
 */
export function rendererPillModeForMainMode(current: PillMode, mainMode: PillMode): PillMode {
  // The picker is renderer-owned. Main never contracts it, and an unrelated
  // hover report must not close a menu the user is still reading.
  return current === "picker" ? current : mainMode;
}

/** Returns the exact transparent native-window bounds needed for this state. */
export function pillSizeFor(
  state: SessionState,
  mode: PillMode = "collapsed",
  activation: DictationActivation | undefined = undefined,
  asrMode: AsrMode = "after-stop",
): PillSize {
  if (state === "idle") return PILL_LAYOUT.idle[mode];
  if (state === "listening") {
    const listening = asrMode === "live" ? PILL_LAYOUT.liveListening : PILL_LAYOUT.listening;
    return listening[activation === "hold" ? "hold" : "toggle"];
  }
  if (state === "error") return PILL_LAYOUT.error.stack;
  return PILL_LAYOUT.status;
}

export type PillLayoutCssVariable =
  | "--pill-idle-collapsed-width"
  | "--pill-idle-collapsed-height"
  | "--pill-idle-hover-width"
  | "--pill-idle-hover-height"
  | "--pill-idle-picker-width"
  | "--pill-idle-picker-height"
  | "--pill-picker-menu-height"
  | "--pill-listening-toggle-width"
  | "--pill-listening-toggle-height"
  | "--pill-listening-hold-width"
  | "--pill-listening-hold-height"
  | "--pill-live-listening-toggle-width"
  | "--pill-live-listening-toggle-height"
  | "--pill-live-listening-hold-width"
  | "--pill-live-listening-hold-height"
  | "--pill-status-width"
  | "--pill-status-height"
  | "--pill-error-stack-width"
  | "--pill-error-stack-height"
  | "--pill-error-notice-width"
  | "--pill-error-notice-min-height"
  | "--pill-rail-width"
  | "--pill-rail-height"
  | "--pill-wave-bar-height";

const px = (value: number): string => `${value}px`;

/** CSS custom properties consumed by the pill surface only. */
export const PILL_LAYOUT_CSS_PROPERTIES = {
  "--pill-idle-collapsed-width": px(PILL_LAYOUT.idle.collapsed.width),
  "--pill-idle-collapsed-height": px(PILL_LAYOUT.idle.collapsed.height),
  "--pill-idle-hover-width": px(PILL_LAYOUT.idle.hover.width),
  "--pill-idle-hover-height": px(PILL_LAYOUT.idle.hover.height),
  "--pill-idle-picker-width": px(PILL_LAYOUT.idle.picker.width),
  "--pill-idle-picker-height": px(PILL_LAYOUT.idle.picker.height),
  "--pill-picker-menu-height": px(PILL_LAYOUT.pickerMenuHeight),
  "--pill-listening-toggle-width": px(PILL_LAYOUT.listening.toggle.width),
  "--pill-listening-toggle-height": px(PILL_LAYOUT.listening.toggle.height),
  "--pill-listening-hold-width": px(PILL_LAYOUT.listening.hold.width),
  "--pill-listening-hold-height": px(PILL_LAYOUT.listening.hold.height),
  "--pill-live-listening-toggle-width": px(PILL_LAYOUT.liveListening.toggle.width),
  "--pill-live-listening-toggle-height": px(PILL_LAYOUT.liveListening.toggle.height),
  "--pill-live-listening-hold-width": px(PILL_LAYOUT.liveListening.hold.width),
  "--pill-live-listening-hold-height": px(PILL_LAYOUT.liveListening.hold.height),
  "--pill-status-width": px(PILL_LAYOUT.status.width),
  "--pill-status-height": px(PILL_LAYOUT.status.height),
  "--pill-error-stack-width": px(PILL_LAYOUT.error.stack.width),
  "--pill-error-stack-height": px(PILL_LAYOUT.error.stack.height),
  "--pill-error-notice-width": px(PILL_LAYOUT.error.notice.width),
  "--pill-error-notice-min-height": px(PILL_LAYOUT.error.notice.minHeight),
  "--pill-rail-width": px(PILL_LAYOUT.rail.width),
  "--pill-rail-height": px(PILL_LAYOUT.rail.height),
  "--pill-wave-bar-height": px(PILL_WAVE_BAR.maxHeight),
} as const satisfies Record<PillLayoutCssVariable, string>;

export const PILL_ERROR_NOTICE_DURATION_CSS_VARIABLE = "--pill-error-notice-duration" as const;

/**
 * Called while rendering the error notice so the visible countdown always
 * consumes the same source of truth as the main-process auto-dismiss timer.
 */
export function pillErrorCountdownCssProperties(
  durationMs = ERROR_NOTICE_DURATION_MS,
): Readonly<Record<typeof PILL_ERROR_NOTICE_DURATION_CSS_VARIABLE, string>> {
  return {
    [PILL_ERROR_NOTICE_DURATION_CSS_VARIABLE]: `${durationMs}ms`,
  };
}
