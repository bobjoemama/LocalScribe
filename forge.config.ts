import type { ForgeConfig, ForgeMakeResult } from "@electron-forge/shared-types";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerZIP } from "@electron-forge/maker-zip";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  assertPackagedAppInventory,
  prunePackagedNativeModules,
  prunePackagedResources,
  pruneStagedNodeModules,
  resourcePolicyFor,
  type PackagedPlatform,
} from "./scripts/package-inventory";
import {
  assertFreshViteBuild,
  assertPackageProvenanceMatches,
  assertPackagedArchive,
  buildPackageProvenance,
  writePackageProvenance,
  type PackageProvenance,
} from "./scripts/package-provenance.mts";
import {
  assertNoRunningPackagedApp,
  listMacProcesses,
} from "./scripts/running-app-guard";
import {
  assertPackagedResourceIntegrity,
  prepareGeneratedResourceIntegrity,
  type PreparedResourceIntegrity,
} from "./src/main/resourceIntegrity";
import { assertExpectedMakeResults } from "./scripts/make-result-safety.mts";
import {
  promoteProtectedResources,
  type ProtectedResourcePreparation,
} from "./scripts/protected-resource-staging.mts";
import {
  loadReleaseMetadata,
  releaseLayout,
} from "./scripts/release-metadata.mts";

const RELEASE_METADATA = loadReleaseMetadata(path.resolve("."));
const MAC_RELEASE = releaseLayout(RELEASE_METADATA, "darwin", path.resolve("."));
const PRODUCT_NAME = RELEASE_METADATA.productName;
const MAC_APP_NAME = MAC_RELEASE.applicationName;
const APP_BUNDLE_ID = RELEASE_METADATA.macBundleId;
const MAC_ENTITLEMENTS = path.resolve("resources/entitlements.mac.plist");
const MAC_HELPER_ENTITLEMENTS = path.resolve("resources/entitlements.mac.helper.plist");
const MAC_PLUGIN_ENTITLEMENTS = path.resolve("resources/entitlements.mac.plugin.plist");
const MAC_ACTIVE_TARGET_ENTITLEMENTS = path.resolve(
  "resources/entitlements.mac.active-target.plist",
);
const MAC_RUNTIME_ENTITLEMENTS = path.resolve("resources/entitlements.mac.runtime.plist");
const MAC_FLUID_AUDIO_HELPER = path.resolve(
  "resources/native/macos/localscribe-fluidaudio-parakeet",
);
const MAC_ACTIVE_TARGET = path.resolve("resources/native/macos/active-target");
const MAC_CANARY_LIBRARY = path.resolve("resources/native/macos/liblocalscribe-canary.dylib");
const MAC_STAGING_ROOT = path.resolve("out/runtime-staging/native/macos");
const MAC_STAGED_ACTIVE_TARGET = path.join(MAC_STAGING_ROOT, "active-target");
const MAC_STAGED_CANARY_LIBRARY = path.join(MAC_STAGING_ROOT, "liblocalscribe-canary.dylib");
const MAC_STAGED_FLUID_AUDIO_HELPER = path.join(
  MAC_STAGING_ROOT,
  "localscribe-fluidaudio-parakeet",
);
const PUBLIC_RELEASE = process.env.LOCALSCRIBE_RELEASE === "1";

function requireReleaseEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Public release mode requires ${name}; refusing to create an unsigned artifact.`);
  }
  return value;
}

function resolveSigningIdentity(): string {
  const configured = process.env.LOCALSCRIBE_CODESIGN_IDENTITY?.trim();
  if (configured) return configured;
  if (process.platform !== "darwin") return "-";
  try {
    const identities = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return identities.match(/"(Apple Development:[^"]+)"/)?.[1] ?? "-";
  } catch {
    return "-";
  }
}

const MAC_SIGNING_IDENTITY = resolveSigningIdentity();
let resourceIntegrityPreparation: PreparedResourceIntegrity | null = null;
let packageProvenanceExpectation: PackageProvenance | null = null;
let packageBuildStartedAtMs = 0;
let protectedResourcePreparation: ProtectedResourcePreparation | null = null;

function restoreTrackedProtectedResources(): void {
  const preparation = protectedResourcePreparation;
  if (!preparation) return;
  preparation.restore();
  protectedResourcePreparation = null;
}

// A failed Forge hook must not strand a signed, timestamped mutation in the
// tracked source tree. Normal restoration happens in postPackage; this covers
// an exception or interrupt before Forge reaches that hook.
process.once("exit", restoreTrackedProtectedResources);

function validatePublicReleaseConfiguration(): void {
  if (!PUBLIC_RELEASE) return;
  if (process.platform === "darwin") {
    if (!MAC_SIGNING_IDENTITY.startsWith("Developer ID Application:")) {
      throw new Error(
        "Public macOS releases require LOCALSCRIBE_CODESIGN_IDENTITY to name a Developer ID Application identity.",
      );
    }
    requireReleaseEnvironment("APPLE_KEYCHAIN_PROFILE");
    if (process.env.LOCALSCRIBE_UNDECLARED_MLX_LICENSE_APPROVED !== "1") {
      throw new Error(
        "Public macOS releases require documented legal approval for every packaged MLX artifact with Undeclared license metadata.",
      );
    }
    return;
  }
  throw new Error(`Public LocalScribe releases cannot be built on ${process.platform}.`);
}

validatePublicReleaseConfiguration();

function signingEntitlementsFor(filePath: string): string {
  const normalizedPath = filePath.replaceAll("\\", "/");
  if (normalizedPath.endsWith("/native/macos/active-target")) {
    return MAC_ACTIVE_TARGET_ENTITLEMENTS;
  }
  if (normalizedPath.includes("/python-runtime/")) {
    return MAC_RUNTIME_ENTITLEMENTS;
  }
  if (normalizedPath.endsWith("/native/macos/localscribe-fluidaudio-parakeet") ||
      normalizedPath.endsWith("/native/macos/liblocalscribe-canary.dylib")) {
    return MAC_RUNTIME_ENTITLEMENTS;
  }
  /*
   * Chromium's crash reporter. It fell through to the main app's plist below,
   * so it shipped signed with `com.apple.security.device.audio-input` and
   * `cs.allow-jit` — a crash handler holding the microphone entitlement. It
   * needs neither. Nothing noticed because the packaged entitlement gate never
   * walked Contents/Frameworks at all.
   */
  if (normalizedPath.endsWith("/chrome_crashpad_handler")) {
    return MAC_RUNTIME_ENTITLEMENTS;
  }
  /*
   * Squirrel's updater helper, and the same fall-through as the crash reporter
   * above: it shipped signed with `device.audio-input` and `cs.allow-jit`. A
   * process whose entire job is to replace the application bundle on disk had
   * the microphone entitlement and permission to map writable-executable
   * memory. It needs neither — it never records and never runs generated code.
   *
   * Found by the Contents/Frameworks walk added to
   * scripts/verify-macos-entitlements.mjs, which is the first thing in this
   * repository ever to look at a nested framework's signature.
   *
   * Matched on the framework rather than on the full versioned path, because
   * @electron/osx-sign reaches this one binary under several: its `walkAsync`
   * calls `stat` where it means `lstat`, so `isSymbolicLink()` is never true
   * and it descends `Versions/Current` and `Resources` as if they were real
   * directories. Pinning `Versions/A/Resources/ShipIt` matched one of those
   * spellings and the later, unmatched one re-signed it with the main app's
   * plist — which is exactly what the first attempt at this fix did.
   */
  if (normalizedPath.includes("/Squirrel.framework/") && normalizedPath.endsWith("/ShipIt")) {
    return MAC_RUNTIME_ENTITLEMENTS;
  }
  if (normalizedPath.includes("LocalScribe Helper (Plugin).app")) {
    return MAC_PLUGIN_ENTITLEMENTS;
  }
  if (normalizedPath.includes("LocalScribe Helper")) {
    return MAC_HELPER_ENTITLEMENTS;
  }
  return MAC_ENTITLEMENTS;
}

const MACH_O_MAGICS = new Set([
  "feedface",
  "feedfacf",
  "cefaedfe",
  "cffaedfe",
  "cafebabe",
  "cafebabf",
  "bebafeca",
  "bfbafeca",
]);

function isMachO(filePath: string): boolean {
  const descriptor = openSync(filePath, "r");
  try {
    const magic = Buffer.alloc(4);
    return readSync(descriptor, magic, 0, magic.length, 0) === magic.length &&
      MACH_O_MAGICS.has(magic.toString("hex"));
  } finally {
    closeSync(descriptor);
  }
}

function collectMachOFiles(directory: string): string[] {
  const files: string[] = [];
  const visit = (candidate: string): void => {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const child of readdirSync(candidate).sort()) {
        visit(path.join(candidate, child));
      }
      return;
    }
    if (stat.isFile() && isMachO(candidate)) files.push(candidate);
  };
  visit(directory);
  return files;
}

/**
 * Electron's signing pass changes Mach-O bytes after Vite embeds the resource
 * root in app.asar. Sign protected loose code first, hash those final bytes,
 * and ask the later app-bundle pass to preserve those already-signed children.
 * The outer app signature still seals every resource in the bundle.
 */
function signProtectedMacResources(): void {
  const runtimeRoot = path.resolve("resources/python-runtime");
  const binaries = [...collectMachOFiles(runtimeRoot), MAC_ACTIVE_TARGET, MAC_FLUID_AUDIO_HELPER, MAC_CANARY_LIBRARY]
    .sort((left, right) => right.split(path.sep).length - left.split(path.sep).length);

  for (const binary of binaries) {
    const arguments_ = [
      "--sign",
      MAC_SIGNING_IDENTITY,
      "--force",
      PUBLIC_RELEASE ? "--timestamp" : "--timestamp=none",
      ...(PUBLIC_RELEASE ? ["--options", "runtime"] : []),
      "--entitlements",
      signingEntitlementsFor(binary),
      binary,
    ];
    execFileSync("codesign", arguments_, { stdio: "ignore" });
    execFileSync("codesign", ["--verify", "--strict", binary], { stdio: "ignore" });
  }
}

function isPreSignedProtectedMacResource(filePath: string): boolean {
  const normalizedPath = filePath.replaceAll("\\", "/");
  return normalizedPath.includes("/Contents/Resources/python-runtime/") ||
    normalizedPath.endsWith("/Contents/Resources/native/macos/active-target") ||
    normalizedPath.endsWith("/Contents/Resources/native/macos/localscribe-fluidaudio-parakeet") ||
    normalizedPath.endsWith("/Contents/Resources/native/macos/liblocalscribe-canary.dylib");
}

function removeInfoPlistKeyIfPresent(infoPlist: string, keyPath: string): void {
  try {
    execFileSync("plutil", ["-extract", keyPath, "xml1", "-o", "-", infoPlist], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    return;
  }
  execFileSync("plutil", ["-remove", keyPath, infoPlist], { stdio: "inherit" });
}

function platformResources(): string[] {
  return [
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_NOTICES.md",
    "worker",
    "resources/model-manifest",
    "resources/python-runtime",
    "resources/native",
    // Copy the curated notice directory as a unit; the platform policy below
    // requires and prunes it to the exact byte-bound license allowlist.
    "resources/licenses",
  ];
}

function resourcesPathInStaging(
  stagingPath: string,
  _platform: PackagedPlatform,
): string {
  return path.join(stagingPath, MAC_APP_NAME, "Contents", "Resources");
}

function packagedResourcesPath(outputPath: string, _platform: PackagedPlatform): string {
  const appPath = outputPath.endsWith(".app")
    ? outputPath
    : path.join(outputPath, MAC_APP_NAME);
  return path.join(appPath, "Contents", "Resources");
}

function assertSourceResources(platform: PackagedPlatform, arch: string): void {
  const policy = resourcePolicyFor(platform, arch);
  const required = [
    path.resolve(policy.workerDirectory, "__init__.py"),
    path.resolve(policy.workerDirectory, "__main__.py"),
    path.resolve("resources", policy.runtimeExecutable),
    ...policy.helperFiles.map((entry) => path.resolve("resources", entry)),
    ...policy.manifestFiles.map((entry) => path.resolve("resources", entry)),
    ...policy.licenseFiles.map((entry) => path.resolve("resources", entry)),
    ...policy.brandingFiles.map((entry) => path.resolve("resources", entry)),
    ...policy.legalFiles.map((entry) => path.resolve(entry)),
  ];
  const missing = required.filter((entry) => !existsSync(entry));
  if (missing.length > 0) {
    throw new Error(
      `Cannot package ${platform}/${arch}; required release resources are missing: ${missing.join(", ")}`,
    );
  }
}

function notarizeAndStapleDmg(dmgPath: string): void {
  const keychainProfile = requireReleaseEnvironment("APPLE_KEYCHAIN_PROFILE");
  const keychainPath = process.env.APPLE_KEYCHAIN_PATH?.trim();
  execFileSync(
    "xcrun",
    [
      "notarytool",
      "submit",
      dmgPath,
      "--keychain-profile",
      keychainProfile,
      ...(keychainPath ? ["--keychain", keychainPath] : []),
      "--wait",
    ],
    { stdio: "inherit" },
  );
  execFileSync("xcrun", ["stapler", "staple", dmgPath], { stdio: "inherit" });
  execFileSync("xcrun", ["stapler", "validate", dmgPath], { stdio: "inherit" });
  execFileSync(
    "spctl",
    [
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      "--verbose=4",
      dmgPath,
    ],
    { stdio: "inherit" },
  );
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    prune: true,
    icon: path.resolve("resources/branding/LocalScribe.icns"),
    // Vite bundles ordinary dependencies, but the main build deliberately keeps
    // native Node modules external. Include only the build, runtime modules, and
    // manifest; afterPrune narrows that manifest to runtime metadata.
    ignore: (file) => {
      if (!file) return false;
      return !(
        file === "/package.json" ||
        file.startsWith("/.vite") ||
        file.startsWith("/node_modules")
      );
    },
    afterPrune: [
      (buildPath, _electronVersion, platform, arch, callback) => {
        void (async () => {
          try {
            await pruneStagedNodeModules(buildPath);
            if (platform !== "darwin") {
              throw new Error(`Unsupported package platform: ${platform}`);
            }
            if (!packageProvenanceExpectation || packageBuildStartedAtMs <= 0) {
              throw new Error("Package provenance was not prepared before the Vite build.");
            }
            assertFreshViteBuild(buildPath, packageBuildStartedAtMs);
            assertPackageProvenanceMatches(
              buildPackageProvenance({
                projectPath: path.resolve("."),
                platform,
                arch,
              }),
              packageProvenanceExpectation,
            );
            writePackageProvenance(buildPath, packageProvenanceExpectation);
            callback();
          } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
          }
        })();
      },
    ],
    afterCopyExtraResources: [
      (stagingPath, _electronVersion, platform, arch, callback) => {
        try {
          if (platform !== "darwin") {
            throw new Error(`Unsupported package platform: ${platform}`);
          }
          const resourcesPath = resourcesPathInStaging(stagingPath, platform);
          prunePackagedResources(resourcesPath, platform, arch);
          prunePackagedNativeModules(resourcesPath, platform, arch);

          const infoPlist = path.join(stagingPath, MAC_APP_NAME, "Contents", "Info.plist");
          removeInfoPlistKeyIfPresent(infoPlist, "NSAppTransportSecurity.NSAllowsArbitraryLoads");
          removeInfoPlistKeyIfPresent(infoPlist, "NSBluetoothAlwaysUsageDescription");
          removeInfoPlistKeyIfPresent(infoPlist, "NSBluetoothPeripheralUsageDescription");
          removeInfoPlistKeyIfPresent(infoPlist, "NSCameraUsageDescription");

          assertPackagedAppInventory(resourcesPath, platform, arch);
          if (!resourceIntegrityPreparation) {
            throw new Error("Resource integrity expectation was not prepared before package staging.");
          }
          // This runs after platform pruning but before Packager's signing step.
          // It independently compares the staged loose tree to the root Vite
          // already bundled into app.asar.
          assertPackagedResourceIntegrity(
            resourcesPath,
            platform,
            arch,
            resourceIntegrityPreparation.expectation,
          );
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
    ],
    extraResource: platformResources(),
    appBundleId: APP_BUNDLE_ID,
    appCategoryType: "public.app-category.productivity",
    appCopyright: "Copyright © 2026 Devesh",
    extendInfo: {
      LSMinimumSystemVersion: RELEASE_METADATA.minimumMacOSVersion,
      NSMicrophoneUsageDescription:
        "LocalScribe records audio only while you dictate and processes it locally on this Mac.",
      NSAudioCaptureUsageDescription:
        "LocalScribe records audio only while you dictate and processes it locally on this Mac.",
    },
    ...(process.platform === "darwin"
      ? {
          osxSign: {
            identity: MAC_SIGNING_IDENTITY,
            identityValidation: MAC_SIGNING_IDENTITY !== "-",
            ignore: isPreSignedProtectedMacResource,
            optionsForFile: (filePath: string) => ({
              entitlements: signingEntitlementsFor(filePath),
              hardenedRuntime: PUBLIC_RELEASE,
              timestamp: PUBLIC_RELEASE ? undefined : "none",
            }),
          },
          ...(PUBLIC_RELEASE
            ? {
                osxNotarize: {
                  keychainProfile: requireReleaseEnvironment("APPLE_KEYCHAIN_PROFILE"),
                  ...(process.env.APPLE_KEYCHAIN_PATH?.trim()
                    ? { keychain: process.env.APPLE_KEYCHAIN_PATH.trim() }
                    : {}),
                },
              }
            : {}),
        }
      : {}),
  },
  hooks: {
    preMake: async () => {
      // Before anything is written. `prePackage` repeats this because `package`
      // is also a standalone entry point that never runs `preMake`.
      assertNoRunningPackagedApp({
        outputDirectory: path.resolve("out"),
        platform: process.platform,
        listProcesses: listMacProcesses,
        projectPath: path.resolve("."),
      });
    },
    prePackage: async (_config, platform, arch) => {
      packageBuildStartedAtMs = Date.now();
      assertNoRunningPackagedApp({
        outputDirectory: path.resolve("out"),
        platform: process.platform,
        listProcesses: listMacProcesses,
        projectPath: path.resolve("."),
      });
      if (platform !== "darwin") {
        throw new Error(`LocalScribe cannot be packaged for ${platform}.`);
      }
      const targetArchitecture =
        arch === MAC_RELEASE.target.arch ? MAC_RELEASE.target.arch : null;
      if (!targetArchitecture) throw new Error(`Unsupported macOS helper architecture: ${arch}`);
      try {
        mkdirSync(MAC_STAGING_ROOT, { recursive: true });
        execFileSync("xcrun", [
          "swiftc",
          "-O",
          "-target",
          `${targetArchitecture}-apple-macos${RELEASE_METADATA.minimumMacOSVersion}`,
          path.resolve("resources/native/macos/active-target.swift"),
          "-o",
          MAC_STAGED_ACTIVE_TARGET,
        ], { stdio: "inherit" });
        restoreTrackedProtectedResources();
        protectedResourcePreparation = promoteProtectedResources([
          { sourcePath: MAC_ACTIVE_TARGET, stagedPath: MAC_STAGED_ACTIVE_TARGET },
          { sourcePath: MAC_FLUID_AUDIO_HELPER, stagedPath: MAC_STAGED_FLUID_AUDIO_HELPER },
          { sourcePath: MAC_CANARY_LIBRARY, stagedPath: MAC_STAGED_CANARY_LIBRARY },
        ]);
        signProtectedMacResources();
        assertSourceResources(platform, arch);
        packageProvenanceExpectation = buildPackageProvenance({
          projectPath: path.resolve("."),
          platform,
          arch,
        });
        resourceIntegrityPreparation?.restore();
        resourceIntegrityPreparation = prepareGeneratedResourceIntegrity({
          resourcesPath: path.resolve("resources"),
          sourceProjectPath: path.resolve("."),
          platform,
          arch,
          generatedModulePath: path.resolve("src/main/generatedResourceIntegrity.ts"),
        });
      } catch (error) {
        restoreTrackedProtectedResources();
        throw error;
      }
    },
    postPackage: async (_config, result) => {
      try {
        if (result.platform !== "darwin") {
          throw new Error(`Unsupported package platform: ${result.platform}`);
        }
        if (!resourceIntegrityPreparation) {
          throw new Error("Resource integrity expectation was not prepared before package verification.");
        }
        for (const outputPath of result.outputPaths) {
          const resourcesPath = packagedResourcesPath(outputPath, result.platform);
          const asarPath = path.join(resourcesPath, "app.asar");
          assertPackagedAppInventory(resourcesPath, result.platform, result.arch);
          assertPackagedArchive({
            asarPath,
            projectPath: path.resolve("."),
            platform: result.platform,
            arch: result.arch,
            expected: packageProvenanceExpectation ?? undefined,
          });
          execFileSync(
            process.execPath,
            [path.resolve("scripts/verify-packaged-main.mjs"), asarPath],
            { stdio: "inherit" },
          );
          assertPackagedResourceIntegrity(
            resourcesPath,
            result.platform,
            result.arch,
            resourceIntegrityPreparation.expectation,
          );

          const appPath = outputPath.endsWith(".app")
            ? outputPath
            : path.join(outputPath, MAC_APP_NAME);
          execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath], {
            stdio: "inherit",
          });
          execFileSync(
            process.execPath,
            [path.resolve("scripts/verify-macos-entitlements.mjs"), appPath],
            { stdio: "inherit" },
          );
          execFileSync(
            process.execPath,
            [
              path.resolve("scripts/verify-macos-bundle.mjs"),
              appPath,
              ...(PUBLIC_RELEASE ? ["--public-release"] : []),
            ],
            { stdio: "inherit" },
          );
          if (PUBLIC_RELEASE) {
            execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" });
            execFileSync("xcrun", ["stapler", "validate", appPath], { stdio: "inherit" });
            execFileSync("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath], {
              stdio: "inherit",
            });
          }
        }
      } finally {
        restoreTrackedProtectedResources();
        resourceIntegrityPreparation?.restore();
        resourceIntegrityPreparation = null;
        packageProvenanceExpectation = null;
        packageBuildStartedAtMs = 0;
      }
    },
    postMake: async (_config, makeResults: ForgeMakeResult[]) => {
      assertExpectedMakeResults(makeResults, process.platform);
      const macResults = makeResults.filter((result) => result.platform === "darwin");
      const macArtifacts = macResults.flatMap((result) => result.artifacts);
      if (macArtifacts.length > 0) {
        const dmgs = macArtifacts.filter((artifact) => artifact.endsWith(".dmg"));
        const zips = macArtifacts.filter((artifact) => artifact.endsWith(".zip"));
        const macTargets = new Set(
          macResults.map((result) => `${result.platform}/${result.arch}`),
        );
        if (dmgs.length !== 1 || zips.length !== 1 || macTargets.size !== 1) {
          throw new Error(
            `macOS make expected one DMG and one ZIP from one target; received ` +
              `${dmgs.length} DMG, ${zips.length} ZIP, ${macTargets.size} target(s).`,
          );
        }
        if (PUBLIC_RELEASE) dmgs.forEach(notarizeAndStapleDmg);
        const macResult = macResults[0];
        if (!macResult) throw new Error("macOS make result disappeared during verification.");
        const stagedApp = path.resolve(
          "out",
          `${PRODUCT_NAME}-darwin-${macResult.arch}`,
          MAC_APP_NAME,
        );
        execFileSync(
          process.execPath,
          [
            path.resolve("scripts/verify-macos-artifacts.mjs"),
            stagedApp,
            dmgs[0]!,
            zips[0]!,
            ...(PUBLIC_RELEASE ? ["--public-release"] : []),
          ],
          { stdio: "inherit" },
        );
      }
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerDMG({
      format: "ULFO",
      ...(PUBLIC_RELEASE && process.platform === "darwin"
        ? {
            additionalDMGOptions: {
              "code-sign": {
                "signing-identity": MAC_SIGNING_IDENTITY,
                identifier: APP_BUNDLE_ID,
              },
            },
          }
        : {}),
    }, ["darwin"]),
    new MakerZIP({}, ["darwin"]),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: "src/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
};

export default config;
