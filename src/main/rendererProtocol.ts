import path from "node:path";

/**
 * The only origin that may serve LocalScribe's bundled renderer.
 *
 * A standard, secure custom protocol is deliberately used instead of file://.
 * Besides avoiding file:// privileges, this gives the main process one small,
 * auditable allow-list for every renderer resource.
 */
export const RENDERER_PROTOCOL_SCHEME = "localscribe";
export const RENDERER_PROTOCOL_HOST = "app";

export type RendererSurface = "settings" | "pill" | "scratchpad";

function encodeSurfaceUrl(baseUrl: string, surface: RendererSurface): string {
  const url = new URL(baseUrl);
  url.searchParams.set("surface", surface);
  return url.toString();
}

/**
 * Builds the renderer URL without changing the Vite development-server path.
 * Packaged builds always use the constrained local protocol origin.
 */
export function rendererUrlForSurface(
  surface: RendererSurface,
  developmentServerUrl?: string,
): string {
  if (developmentServerUrl) return encodeSurfaceUrl(developmentServerUrl, surface);
  return encodeSurfaceUrl(
    `${RENDERER_PROTOCOL_SCHEME}://${RENDERER_PROTOCOL_HOST}/index.html`,
    surface,
  );
}

/**
 * Selects the renderer origin for the current application mode. Packaged
 * builds must ignore an accidentally injected Vite URL and remain on the
 * local, allow-listed custom protocol.
 */
export function rendererUrlForRuntime(
  surface: RendererSurface,
  isPackaged: boolean,
  developmentServerUrl?: string,
): string {
  return rendererUrlForSurface(
    surface,
    isPackaged ? undefined : developmentServerUrl,
  );
}

function rawPathFromRendererUrl(url: string): string | null {
  const schemePrefix = `${RENDERER_PROTOCOL_SCHEME}://`;
  if (!url.toLowerCase().startsWith(schemePrefix)) return null;

  const withoutScheme = url.slice(schemePrefix.length);
  const pathStart = withoutScheme.search(/[/?#]/);
  const authority = pathStart === -1 ? withoutScheme : withoutScheme.slice(0, pathStart);
  if (authority !== RENDERER_PROTOCOL_HOST) return null;

  if (pathStart === -1) return "/";
  const suffix = withoutScheme.slice(pathStart);
  const queryStart = suffix.search(/[?#]/);
  return queryStart === -1 ? suffix : suffix.slice(0, queryStart);
}

function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Resolves a renderer request to a file under `rendererRoot`, or rejects it.
 *
 * Validation uses the raw URL path as well as URL parsing.  This rejects
 * percent-encoded dot-segments and path separators before Node can interpret
 * them, including on Windows where a backslash is a path separator.
 */
export function resolvePackagedRendererPath(requestUrl: string, rendererRoot: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== `${RENDERER_PROTOCOL_SCHEME}:`
    || parsed.hostname !== RENDERER_PROTOCOL_HOST
    || parsed.port !== ""
    || parsed.username !== ""
    || parsed.password !== ""
  ) {
    return null;
  }

  const rawPath = rawPathFromRendererUrl(requestUrl);
  if (rawPath === null || !rawPath.startsWith("/")) return null;

  const rawSegments = rawPath.split("/").slice(1);
  const pathSegments: string[] = [];
  for (const rawSegment of rawSegments) {
    if (rawSegment === "") continue;
    const segment = decodePathSegment(rawSegment);
    if (
      segment === null
      || segment === "."
      || segment === ".."
      || segment.includes("\0")
      || segment.includes("/")
      || segment.includes("\\")
    ) {
      return null;
    }
    pathSegments.push(segment);
  }

  const resolvedRoot = path.resolve(rendererRoot);
  const requestedPath = path.resolve(resolvedRoot, ...(pathSegments.length > 0 ? pathSegments : ["index.html"]));
  const relative = path.relative(resolvedRoot, requestedPath);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return requestedPath;
}
