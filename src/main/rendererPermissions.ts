import type { RendererSurface } from "./rendererProtocol";

/*
 * Chromium's default permission manager grants every web permission it is
 * asked for, and nothing in this app had ever replaced it. That is the single
 * item from Electron's security checklist the rest of main implements
 * meticulously — sandbox, contextIsolation, webSecurity, a deny-all window
 * open handler, a will-navigate block, and the packaging fuses — so the gap was
 * an omission rather than a decision.
 *
 * It matters here more than in a browser-shaped app: these renderers hold
 * decrypted transcripts, and the Scratchpad and Settings windows have no
 * business opening a microphone, reading the clipboard, or asking to be granted
 * anything at all. The whole surface is closed by default and reopened one
 * capability at a time, named against the one caller that needs it.
 */

/**
 * The permissions each renderer is allowed to be granted, and why.
 *
 * `media`
 *   - pill: `audioRecorder.ts` calls `getUserMedia`. This is the dictation
 *     microphone; without it the app does nothing.
 *   - settings: `enumerateDevices` in the microphone picker returns unlabelled
 *     entries unless the surface may hold media access, which would leave the
 *     list unusable.
 *
 * `clipboard-sanitized-write`
 *   - `navigator.clipboard.writeText` in the Copy transcript, Copy scratchpad
 *     note, and Copy diagnostics controls. Write only — `clipboard-read` is
 *     never granted, so no renderer can read what the user copied elsewhere.
 */
const ALLOWED: Readonly<Record<RendererSurface, readonly string[]>> = {
  pill: ["media"],
  settings: ["media", "clipboard-sanitized-write"],
  scratchpad: ["clipboard-sanitized-write"],
};

/**
 * Whether a renderer may be granted a permission.
 *
 * An unrecognised surface — a webContents this app did not create, which is
 * what a compromised or injected frame would look like — is granted nothing.
 * Same for an unrecognised permission: a capability Electron adds later must
 * arrive denied rather than inheriting a default grant.
 */
export function rendererPermissionAllowed(
  surface: RendererSurface | null,
  permission: string,
): boolean {
  if (surface === null) return false;
  return ALLOWED[surface].includes(permission);
}

/** The permissions a surface may hold, for tests and for the startup log. */
export function allowedRendererPermissions(surface: RendererSurface): readonly string[] {
  return ALLOWED[surface];
}
