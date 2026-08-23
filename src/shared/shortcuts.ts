import { z } from "zod";

/**
 * Electron accelerators are strings, not a closed set of application presets.
 * Keep that representation at the boundary, while storing one stable spelling
 * so comparisons, persistence, menus, and native registration agree.
 */
export type HoldShortcut = string;
export type ToggleShortcut = string;
export type ShortcutKind = "hold" | "toggle";
export type ShortcutDisplayPlatform = "darwin";

const MODIFIER_ORDER = [
  "CommandOrControl",
  "Command",
  "Control",
  "Alt",
  "AltGr",
  "Shift",
  "Super",
  "Meta",
] as const;

const MODIFIER_ALIASES: Record<string, (typeof MODIFIER_ORDER)[number]> = {
  command: "Command",
  cmd: "Command",
  control: "Control",
  ctrl: "Control",
  commandorcontrol: "CommandOrControl",
  cmdorctrl: "CommandOrControl",
  alt: "Alt",
  option: "Alt",
  altgr: "AltGr",
  shift: "Shift",
  super: "Super",
  meta: "Meta",
};

const KEY_ALIASES: Record<string, string> = {
  space: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  return: "Return",
  enter: "Enter",
  escape: "Escape",
  esc: "Escape",
  up: "Up",
  arrowup: "Up",
  down: "Down",
  arrowdown: "Down",
  left: "Left",
  arrowleft: "Left",
  right: "Right",
  arrowright: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  plus: "Plus",
  numdec: "numdec",
  numpaddecimal: "numdec",
  numadd: "numadd",
  numpadadd: "numadd",
  numsub: "numsub",
  numpadsubtract: "numsub",
  nummult: "nummult",
  numpadmultiply: "nummult",
  numdiv: "numdiv",
  numpaddivide: "numdiv",
  numenter: "NumpadEnter",
  numpadenter: "NumpadEnter",
  capslock: "CapsLock",
  numlock: "NumLock",
  scrolllock: "ScrollLock",
  printscreen: "PrintScreen",
  minus: "Minus",
  equal: "Equal",
  comma: "Comma",
  period: "Period",
  slash: "Slash",
  semicolon: "Semicolon",
  quote: "Quote",
  backquote: "Backquote",
  bracketleft: "BracketLeft",
  bracketright: "BracketRight",
  backslash: "Backslash",
  intlbackslash: "Backslash",
};

const KEY_TOKEN_LABELS: Record<string, string> = {
  Up: "Up Arrow",
  Down: "Down Arrow",
  Left: "Left Arrow",
  Right: "Right Arrow",
  PageUp: "Page Up",
  PageDown: "Page Down",
  NumpadEnter: "Numpad Enter",
};

const COMPACT_KEY_TOKEN_LABELS: Record<string, string> = {
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  PageUp: "PgUp",
  PageDown: "PgDn",
  NumpadEnter: "Num Enter",
};

/**
 * LocalScribe ships for macOS, so every saved accelerator is presented with
 * the terms printed on a Mac keyboard. The accelerator itself remains the
 * stable value used by Electron and the native shortcut monitor.
 */
export function shortcutDisplayPlatform(): ShortcutDisplayPlatform {
  return "darwin";
}

function tokenDisplayLabel(token: string): string {
  switch (token) {
    case "CommandOrControl":
    case "Command":
    case "Super":
    case "Meta": return "Command";
    case "Control": return "Control";
    case "Alt": return "Option";
    case "AltGr": return "AltGr";
    case "Shift": return "Shift";
    default: return KEY_TOKEN_LABELS[token] ?? token;
  }
}

function compactTokenDisplayLabel(token: string): string {
  switch (token) {
    case "CommandOrControl":
    case "Command":
    case "Super":
    case "Meta": return "⌘";
    case "Control": return "⌃";
    case "Alt": return "⌥";
    case "AltGr": return "AltGr";
    case "Shift": return "⇧";
    default: return COMPACT_KEY_TOKEN_LABELS[token] ?? token;
  }
}

export interface ParsedShortcut {
  canonical: string;
  tokens: string[];
  modifiers: string[];
  key: string | null;
}

function normalizedToken(value: string): string {
  return value.trim().replace(/[\s_-]+/g, "").toLowerCase();
}

function canonicalKey(rawToken: string): string | null {
  const normalized = normalizedToken(rawToken);
  if (KEY_ALIASES[normalized]) return KEY_ALIASES[normalized];
  if (/^[a-z]$/.test(normalized)) return normalized.toUpperCase();
  if (/^[0-9]$/.test(normalized)) return normalized;
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(normalized)) return normalized.toUpperCase();
  if (/^num[0-9]$/.test(normalized)) return normalized;
  return null;
}

/** Parses the common keyboard portion of Electron's Accelerator grammar. */
export function parseShortcut(shortcut: string): ParsedShortcut {
  if (typeof shortcut !== "string") throw new Error("Shortcut must be text.");
  const source = shortcut.trim();
  if (!source) throw new Error("Choose a shortcut.");
  if (source.length > 120) throw new Error("Shortcut is too long.");

  const parts = source.split("+");
  if (parts.some((part) => !part.trim())) {
    throw new Error("Use + between shortcut keys.");
  }

  const modifiers = new Set<string>();
  let key: string | null = null;
  for (const part of parts) {
    const normalized = normalizedToken(part);
    const modifier = MODIFIER_ALIASES[normalized];
    if (modifier) {
      if (modifiers.has(modifier)) throw new Error(`Shortcut repeats ${modifier}.`);
      modifiers.add(modifier);
      continue;
    }
    const parsedKey = canonicalKey(part);
    if (!parsedKey) throw new Error(`Unsupported shortcut key: ${part.trim()}.`);
    if (key) throw new Error("A shortcut can contain only one non-modifier key.");
    key = parsedKey;
  }

  const orderedModifiers = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  const tokens = key ? [...orderedModifiers, key] : orderedModifiers;
  if (!tokens.length) throw new Error("Choose at least one key.");
  return { canonical: tokens.join("+"), tokens, modifiers: orderedModifiers, key };
}

export function canonicalizeShortcut(shortcut: string): string {
  return parseShortcut(shortcut).canonical;
}

export function shortcutTokens(shortcut: string): string[] {
  return parseShortcut(shortcut).tokens;
}

export function isModifierToken(token: string): boolean {
  return (MODIFIER_ORDER as readonly string[]).includes(token);
}

export function isModifierOnlyShortcut(shortcut: string): boolean {
  return parseShortcut(shortcut).key === null;
}

export function shortcutDisplayLabel(shortcut: string): string {
  return shortcutTokens(shortcut).map(tokenDisplayLabel).join(" + ");
}

export function shortcutCompactLabel(shortcut: string): string {
  return shortcutTokens(shortcut).map(compactTokenDisplayLabel).join(" + ");
}

type PhysicalKeyGroup = readonly string[];

/**
 * Groups the logical accelerator tokens by the physical keys that can produce
 * them. This keeps Command/Super/Meta aliases, CommandOrControl, AltGr, and
 * the physical Shift+Equal form of Plus from drifting apart in comparisons.
 */
function physicalKeyGroupsForToken(
  token: string,
): readonly PhysicalKeyGroup[] {
  switch (token) {
    case "Control": return [["control-left", "control-right"]];
    case "Command":
    case "Super":
    case "Meta": return [["meta-left", "meta-right"]];
    case "CommandOrControl": return [["meta-left", "meta-right"]];
    case "Alt": return [["alt-left", "alt-right"]];
    case "AltGr": return [["alt-right"]];
    case "Shift": return [["shift-left", "shift-right"]];
    // uiohook observes a physical Plus as Shift+Equal on common layouts.
    case "Plus": return [["shift-left", "shift-right"], ["key:Equal"]];
    // Electron accepts both spellings for the main Enter key. NumpadEnter is
    // intentionally separate because uiohook reports its own physical code.
    case "Return":
    case "Enter": return [["key:Enter"]];
    default: return [[`key:${token}`]];
  }
}

/** Physical key groups required by a shortcut on the current platform. */
export function shortcutPhysicalKeyGroups(shortcut: string): readonly PhysicalKeyGroup[] {
  const seen = new Set<string>();
  return shortcutTokens(shortcut)
    .flatMap((token) => physicalKeyGroupsForToken(token))
    .filter((group) => {
      const identity = [...group].sort().join(",");
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
}

function physicalGroupsCanUseSameKey(left: PhysicalKeyGroup, right: PhysicalKeyGroup): boolean {
  return left.some((key) => right.includes(key));
}

function physicalGroupsCanMatch(
  left: readonly PhysicalKeyGroup[],
  right: readonly PhysicalKeyGroup[],
  leftIndex = 0,
  usedRight = new Set<number>(),
): boolean {
  if (leftIndex === left.length) return true;
  const leftGroup = left[leftIndex];
  if (!leftGroup) return false;
  for (const [rightIndex, rightGroup] of right.entries()) {
    if (usedRight.has(rightIndex) || !physicalGroupsCanUseSameKey(leftGroup, rightGroup)) continue;
    const nextUsed = new Set(usedRight);
    nextUsed.add(rightIndex);
    if (physicalGroupsCanMatch(left, right, leftIndex + 1, nextUsed)) return true;
  }
  return false;
}

/**
 * True when both accelerators can resolve to the same physical chord on a Mac.
 * Groups can overlap without being textually identical: Option accepts either
 * Option key while AltGr is specifically the right Option key.
 */
export function shortcutsUseSamePhysicalKeys(
  left: string,
  right: string,
): boolean {
  const leftGroups = shortcutPhysicalKeyGroups(left);
  const rightGroups = shortcutPhysicalKeyGroups(right);
  return leftGroups.length === rightGroups.length
    && physicalGroupsCanMatch(leftGroups, rightGroups);
}

/** True if a toggle shares any physical key/modifier with the hold shortcut. */
export function toggleUsesHoldKey(
  toggle: string,
  hold: string,
): boolean {
  const holdGroups = shortcutPhysicalKeyGroups(hold);
  return shortcutPhysicalKeyGroups(toggle).some((toggleGroup) =>
    holdGroups.some((holdGroup) => toggleGroup.some((key) => holdGroup.includes(key))),
  );
}

function shortcutSchemaFor(kind: ShortcutKind) {
  return z.string().trim().min(1).max(120).transform((value, context) => {
    try {
      const parsed = parseShortcut(value);
      const kindError = shortcutKindValidationError(kind, parsed);
      if (kindError) {
        context.addIssue({
          code: "custom",
          message: kindError,
        });
        return z.NEVER;
      }
      return parsed.canonical;
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid shortcut.",
      });
      return z.NEVER;
    }
  });
}

export const NUMPAD_ENTER_TOGGLE_ERROR =
  "Toggle dictation cannot use Numpad Enter because the system shortcut API does not support it as a distinct global shortcut. Choose another key.";

export function shortcutKindValidationError(
  kind: ShortcutKind,
  parsed: ParsedShortcut,
): string | null {
  if (kind === "toggle" && parsed.key === null) {
    return "Toggle dictation needs a non-modifier key so the system can register it.";
  }
  if (kind === "toggle" && parsed.key === "NumpadEnter") {
    return NUMPAD_ENTER_TOGGLE_ERROR;
  }
  return null;
}

export const holdShortcutSchema = shortcutSchemaFor("hold");
export const toggleShortcutSchema = shortcutSchemaFor("toggle");

export const shortcutValidationRequestSchema = z.object({
  kind: z.enum(["hold", "toggle"]),
  shortcut: z.string().trim().min(1).max(120),
  otherShortcut: z.string().trim().min(1).max(120).optional(),
});
export type ShortcutValidationRequest = z.infer<typeof shortcutValidationRequestSchema>;

/** A committed recorder value. The main process supplies the other shortcut. */
export const shortcutUpdateRequestSchema = z.object({
  kind: z.enum(["hold", "toggle"]),
  shortcut: z.string().trim().min(1).max(120),
}).strict();
export type ShortcutUpdateRequest = z.infer<typeof shortcutUpdateRequestSchema>;

export const shortcutValidationResultSchema = z.object({
  shortcut: z.string(),
  available: z.boolean(),
  error: z.string().optional(),
  warning: z.string().optional(),
});
export type ShortcutValidationResult = z.infer<typeof shortcutValidationResultSchema>;
