import type { DictationActivation, PillMode, SessionState } from "./contracts";
import { ERROR_NOTICE_DURATION_MS } from "./dictationErrors";

export interface PillSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The transparent native window and the renderer must agree on these bounds.
 * Keep the window-facing sizes here instead of duplicating magic dimensions in
 * the main process and the pill stylesheet.
 */
export const PILL_LAYOUT = {
  idle: {
    collapsed: { width: 40, height: 8 },
    hover: { width: 146, height: 64 },
    picker: { width: 210, height: 212 },
  },
  listening: {
    hold: { width: 76, height: 26 },
    toggle: { width: 100, height: 32 },
  },
  status: { width: 128, height: 32 },
  error: {
    stack: { width: 336, height: 100 },
    notice: { width: 328, minHeight: 82 },
  },
  rail: { width: 39, height: 7 },
  pickerMenuHeight: 210,
} as const satisfies {
  idle: Record<PillMode, PillSize>;
  listening: Record<DictationActivation, PillSize>;
  status: PillSize;
  error: {
    stack: PillSize;
    notice: { readonly width: number; readonly minHeight: number };
  };
  rail: PillSize;
  pickerMenuHeight: number;
};

export const PILL_WINDOW_BOTTOM_MARGIN = 8;
export const PILL_HOVER_HIT_PADDING = 10;

/** Returns the exact transparent native-window bounds needed for this state. */
export function pillSizeFor(
  state: SessionState,
  mode: PillMode = "collapsed",
  activation: DictationActivation | undefined = undefined,
): PillSize {
  if (state === "idle") return PILL_LAYOUT.idle[mode];
  if (state === "listening") return PILL_LAYOUT.listening[activation === "hold" ? "hold" : "toggle"];
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
  | "--pill-status-width"
  | "--pill-status-height"
  | "--pill-error-stack-width"
  | "--pill-error-stack-height"
  | "--pill-error-notice-width"
  | "--pill-error-notice-min-height"
  | "--pill-rail-width"
  | "--pill-rail-height";

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
  "--pill-status-width": px(PILL_LAYOUT.status.width),
  "--pill-status-height": px(PILL_LAYOUT.status.height),
  "--pill-error-stack-width": px(PILL_LAYOUT.error.stack.width),
  "--pill-error-stack-height": px(PILL_LAYOUT.error.stack.height),
  "--pill-error-notice-width": px(PILL_LAYOUT.error.notice.width),
  "--pill-error-notice-min-height": px(PILL_LAYOUT.error.notice.minHeight),
  "--pill-rail-width": px(PILL_LAYOUT.rail.width),
  "--pill-rail-height": px(PILL_LAYOUT.rail.height),
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
