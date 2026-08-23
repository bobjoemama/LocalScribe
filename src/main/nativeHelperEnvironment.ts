/**
 * Native helpers receive no ambient application environment.
 *
 * Absolute helper paths make PATH unnecessary, and forwarding the parent
 * environment would expose unrelated credentials such as API tokens and
 * proxy URLs to a child that does not need them.
 */
export function nativeHelperEnvironment(
  _platform: NodeJS.Platform = process.platform,
  _environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {};
}
