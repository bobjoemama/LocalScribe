/**
 * Stable product identity and deliberately supported binary targets.
 * Versions and human-facing names come from package.json; these identifiers
 * must not drift when a package version or release tag changes.
 */
export const RELEASE_POLICY = {
  macBundleId: "com.localscribe.desktop",
  windowsAppUserModelId: "com.localscribe.desktop",
  minimumMacOSVersion: "14.0",
  targets: {
    darwin: {
      arch: "arm64",
      label: "macos-arm64",
    },
    win32: {
      arch: "x64",
      label: "windows-x64",
    },
  },
} as const;
