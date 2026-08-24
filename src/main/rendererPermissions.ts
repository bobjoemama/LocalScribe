import type { RendererSurface } from "./rendererProtocol";

/*
 * Electron exposes two distinct permission boundaries. A permission *check*
 * can answer a capability/metadata query, while a permission *request* can
 * authorize the operation itself. Keeping those decisions separate matters
 * for Settings: its microphone picker needs stable device ids and labels from
 * enumerateDevices(), but Settings must never open a capture stream.
 */

export interface RendererPermissionCheckDetails {
  readonly isMainFrame: boolean;
  readonly mediaType?: "audio" | "video" | "unknown";
}

export interface RendererPermissionRequestDetails {
  readonly isMainFrame: boolean;
  readonly mediaTypes?: readonly ("audio" | "video")[];
}

/** Non-media capabilities used by explicit renderer controls. */
const CHECK_ALLOWED: Readonly<Record<RendererSurface, readonly string[]>> = {
  pill: ["media"],
  settings: ["media", "clipboard-sanitized-write"],
  scratchpad: ["clipboard-sanitized-write"],
};

const REQUEST_ALLOWED: Readonly<Record<RendererSurface, readonly string[]>> = {
  pill: ["media"],
  settings: ["clipboard-sanitized-write"],
  scratchpad: ["clipboard-sanitized-write"],
};

function isTrustedMainFrame(
  surface: RendererSurface | null,
  details: { readonly isMainFrame: boolean },
): surface is RendererSurface {
  return surface !== null && details.isMainFrame;
}

/**
 * Answers Chromium's permission checks.
 *
 * Settings and Pill may inspect audio-input metadata. Camera, mixed-media and
 * unknown media checks are denied. An unexpected webContents or any subframe
 * is denied before its requested capability is considered.
 */
export function rendererPermissionCheckAllowed(
  surface: RendererSurface | null,
  permission: string,
  details: RendererPermissionCheckDetails,
): boolean {
  if (!isTrustedMainFrame(surface, details)) return false;
  if (!CHECK_ALLOWED[surface].includes(permission)) return false;

  if (permission === "media") {
    return (surface === "pill" || surface === "settings")
      && details.mediaType === "audio";
  }
  return true;
}

/**
 * Answers Chromium's permission requests.
 *
 * Only Pill may request a capture stream, and only for one explicitly declared
 * audio media type. Settings can enumerate microphones but cannot capture;
 * missing, video, mixed, duplicated, or otherwise malformed media lists deny.
 */
export function rendererPermissionRequestAllowed(
  surface: RendererSurface | null,
  permission: string,
  details: RendererPermissionRequestDetails,
): boolean {
  if (!isTrustedMainFrame(surface, details)) return false;
  if (!REQUEST_ALLOWED[surface].includes(permission)) return false;

  if (permission === "media") {
    return surface === "pill"
      && details.mediaTypes?.length === 1
      && details.mediaTypes[0] === "audio";
  }
  return true;
}

/** Permission names a surface may pass at the check boundary. */
export function allowedRendererPermissionChecks(surface: RendererSurface): readonly string[] {
  return CHECK_ALLOWED[surface];
}

/** Permission names a surface may pass at the request boundary. */
export function allowedRendererPermissionRequests(surface: RendererSurface): readonly string[] {
  return REQUEST_ALLOWED[surface];
}
