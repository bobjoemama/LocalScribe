import path from "node:path";

function validatedWindowsDirectory(
  name: "SystemRoot" | "WINDIR",
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  if (value.includes("\0") || value !== value.trim()) {
    throw new Error(`${name} must be a clean absolute Windows directory path`);
  }
  const normalized = path.win32.normalize(value);
  const root = path.win32.parse(normalized).root;
  const canonical = normalized.length > root.length
    ? normalized.replace(/\\+$/u, "")
    : normalized;
  if (!/^[A-Za-z]:\\/u.test(canonical) || canonical === root) {
    throw new Error(`${name} must be a drive-absolute Windows directory path`);
  }
  return canonical;
}

/**
 * Returns the only ambient Windows values required by native runtimes.
 *
 * They remain environment-controlled inputs, so validate them before passing
 * them across a child-process trust boundary. SystemRoot and WINDIR are aliases
 * for the same OS directory and must not disagree.
 */
export function validatedWindowsRuntimeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const systemRoot = validatedWindowsDirectory("SystemRoot", environment.SystemRoot);
  const windowsDirectory = validatedWindowsDirectory("WINDIR", environment.WINDIR);
  if (
    systemRoot
    && windowsDirectory
    && systemRoot.toLocaleLowerCase("en-US") !== windowsDirectory.toLocaleLowerCase("en-US")
  ) {
    throw new Error("SystemRoot and WINDIR must identify the same Windows directory");
  }
  return {
    ...(systemRoot ? { SystemRoot: systemRoot } : {}),
    ...(windowsDirectory ? { WINDIR: windowsDirectory } : {}),
  };
}

/**
 * Native helpers receive no ambient application environment.
 *
 * Absolute helper paths make PATH unnecessary, and forwarding the parent
 * environment would expose unrelated credentials such as API tokens and
 * proxy URLs to a child that does not need them. Windows' native loader and
 * system APIs may need these two non-secret OS locations.
 */
export function nativeHelperEnvironment(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (platform !== "win32") return {};
  return validatedWindowsRuntimeEnvironment(environment);
}
