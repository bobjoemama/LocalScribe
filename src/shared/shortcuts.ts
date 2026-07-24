import { z } from "zod";

/**
 * Electron accelerators are strings, not a closed set of application presets.
 * Keep that representation at the boundary, while storing one stable spelling
 * so comparisons, persistence, menus, and native registration agree.
 */
export type HoldShortcut = string;
export type ToggleShortcut = string;
export type ShortcutKind = "hold" | "toggle";
export type ShortcutDisplayPlatform = "darwin" | "win32" | "linux";

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
  numpadenter: "Enter",
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
};

const COMPACT_KEY_TOKEN_LABELS: Record<string, string> = {
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  PageUp: "PgUp",
  PageDown: "PgDn",
};

/**
 * Render the saved Electron accelerator using the terms users see on their
 * current operating system. The accelerator itself stays platform-neutral.
 */
export function shortcutDisplayPlatform(): ShortcutDisplayPlatform {
  const processPlatform = typeof process !== "undefined" ? process.platform : undefined;
  if (processPlatform === "darwin" || processPlatform === "win32" || processPlatform === "linux") {
    return processPlatform;
  }

  const platform = typeof navigator !== "undefined" ? navigator.platform.toLocaleLowerCase() : "";
  if (platform.includes("mac")) return "darwin";
  if (platform.includes("win")) return "win32";
  return "linux";
}

function tokenDisplayLabel(token: string, platform: ShortcutDisplayPlatform): string {
  switch (token) {
    case "CommandOrControl": return platform === "darwin" ? "Command" : "Control";
    case "Command": return platform === "darwin" ? "Command" : platform === "win32" ? "Windows" : "Super";
    case "Control": return "Control";
    case "Alt": return platform === "darwin" ? "Option" : "Alt";
    case "AltGr": return "AltGr";
    case "Shift": return "Shift";
    case "Super": return platform === "darwin" ? "Command" : platform === "win32" ? "Windows" : "Super";
    case "Meta": return platform === "darwin" ? "Command" : platform === "win32" ? "Windows" : "Meta";
    default: return KEY_TOKEN_LABELS[token] ?? token;
  }
}

function compactTokenDisplayLabel(token: string, platform: ShortcutDisplayPlatform): string {
  if (platform === "darwin") {
    switch (token) {
      case "CommandOrControl":
      case "Command":
      case "Super":
      case "Meta": return "⌘";
      case "Control": return "⌃";
      case "Alt": return "⌥";
      case "Shift": return "⇧";
      default: return COMPACT_KEY_TOKEN_LABELS[token] ?? token;
    }
  }
  switch (token) {
    case "CommandOrControl":
    case "Control": return "Ctrl";
    case "Command":
    case "Super":
    case "Meta": return platform === "win32" ? "Win" : "Super";
    case "Alt": return "Alt";
    case "AltGr": return "AltGr";
    case "Shift": return "Shift";
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

export function shortcutDisplayLabel(
  shortcut: string,
  platform = shortcutDisplayPlatform(),
): string {
  return shortcutTokens(shortcut).map((token) => tokenDisplayLabel(token, platform)).join(" + ");
}

export function shortcutCompactLabel(
  shortcut: string,
  platform = shortcutDisplayPlatform(),
): string {
  return shortcutTokens(shortcut).map((token) => compactTokenDisplayLabel(token, platform)).join(" + ");
}

type PhysicalKeyGroup = readonly string[];

/**
 * Groups the logical accelerator tokens by the physical keys that can produce
 * them. This keeps Command/Super/Meta aliases, CommandOrControl, AltGr, and
 * the physical Shift+Equal form of Plus from drifting apart in comparisons.
 */
function physicalKeyGroupsForToken(
  token: string,
  platform: string,
): readonly PhysicalKeyGroup[] {
  switch (token) {
    case "Control": return [["control-left", "control-right"]];
    case "Command":
    case "Super":
    case "Meta": return [["meta-left", "meta-right"]];
    case "CommandOrControl":
      return platform === "darwin"
        ? [["meta-left", "meta-right"]]
        : [["control-left", "control-right"]];
    case "Alt": return [["alt-left", "alt-right"]];
    case "AltGr": return [["alt-right"]];
    case "Shift": return [["shift-left", "shift-right"]];
    // uiohook observes a physical Plus as Shift+Equal on common layouts.
    case "Plus": return [["shift-left", "shift-right"], ["key:Equal"]];
    // Electron accepts both spellings, but the keyboard has one Enter key.
    case "Return":
    case "Enter": return [["key:Enter"]];
    default: return [[`key:${token}`]];
  }
}

/** Physical key groups required by a shortcut on the current platform. */
export function shortcutPhysicalKeyGroups(
  shortcut: string,
  platform: string = shortcutDisplayPlatform(),
): readonly PhysicalKeyGroup[] {
  const seen = new Set<string>();
  return shortcutTokens(shortcut)
    .flatMap((token) => physicalKeyGroupsForToken(token, platform))
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
 * True when both accelerators can resolve to the same physical chord on this
 * platform. Groups can overlap without being textually identical: Windows
 * Alt accepts either Alt key while AltGr is specifically right Alt.
 */
export function shortcutsUseSamePhysicalKeys(
  left: string,
  right: string,
  platform: string = shortcutDisplayPlatform(),
): boolean {
  const leftGroups = shortcutPhysicalKeyGroups(left, platform);
  const rightGroups = shortcutPhysicalKeyGroups(right, platform);
  return leftGroups.length === rightGroups.length
    && physicalGroupsCanMatch(leftGroups, rightGroups);
}

/** True if a toggle shares any physical key/modifier with the hold shortcut. */
export function toggleUsesHoldKey(
  toggle: string,
  hold: string,
  platform: string = shortcutDisplayPlatform(),
): boolean {
  const holdGroups = shortcutPhysicalKeyGroups(hold, platform);
  return shortcutPhysicalKeyGroups(toggle, platform).some((toggleGroup) =>
    holdGroups.some((holdGroup) => toggleGroup.some((key) => holdGroup.includes(key))),
  );
}

function shortcutSchemaFor(kind: ShortcutKind) {
  return z.string().trim().min(1).max(120).transform((value, context) => {
    try {
      const parsed = parseShortcut(value);
      if (kind === "toggle" && parsed.key === null) {
        context.addIssue({
          code: "custom",
          message: "Toggle dictation needs a non-modifier key so macOS can register it.",
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
