import type { ForgeConfig, ForgeMakeResult } from "@electron-forge/shared-types";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import {
  closeSync,
  existsSync,
  lstatSync,
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
  assertPackagedResourceIntegrity,
  prepareGeneratedResourceIntegrity,
  type PreparedResourceIntegrity,
} from "./src/main/resourceIntegrity";
import {
  assertFreshOrdinaryArtifact,
  clearWindowsMakerOutput,
} from "./scripts/windows-artifact-safety.mts";
import { assertExpectedMakeResults } from "./scripts/make-result-safety.mts";
import {
  loadReleaseMetadata,
  releaseLayout,
} from "./scripts/release-metadata.mts";

const RELEASE_METADATA = loadReleaseMetadata(path.resolve("."));
const MAC_RELEASE = releaseLayout(RELEASE_METADATA, "darwin", path.resolve("."));
const WINDOWS_RELEASE = releaseLayout(RELEASE_METADATA, "win32", path.resolve("."));
const PRODUCT_NAME = RELEASE_METADATA.productName;
const MAC_APP_NAME = MAC_RELEASE.applicationName;
const WINDOWS_EXE_NAME = WINDOWS_RELEASE.applicationName;
const APP_BUNDLE_ID = RELEASE_METADATA.macBundleId;
const MAC_ENTITLEMENTS = path.resolve("resources/entitlements.mac.plist");
const MAC_HELPER_ENTITLEMENTS = path.resolve("resources/entitlements.mac.helper.plist");
const MAC_PLUGIN_ENTITLEMENTS = path.resolve("resources/entitlements.mac.plugin.plist");
const MAC_ACTIVE_TARGET_ENTITLEMENTS = path.resolve(
  "resources/entitlements.mac.active-target.plist",
);
const MAC_RUNTIME_ENTITLEMENTS = path.resolve("resources/entitlements.mac.runtime.plist");
const PUBLIC_RELEASE = process.env.LOCALSCRIBE_RELEASE === "1";
// Squirrel's 32-bit WriteZipToSetup helper silently leaves its dummy payload
// in Setup.exe once LocalScribe's CUDA runtime pushes the package near 1 GiB.
// Portable ZIP is the supported Windows output. This opt-in exists only so
// the fail-closed regression gate can diagnose a future smaller package or
// upstream replacement; it is never a supported release path.
const BUILD_LEGACY_SQUIRREL =
  process.env.LOCALSCRIBE_BUILD_LEGACY_SQUIRREL === "1";

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
let makeBuildStartedAtMs = 0;

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
  if (process.platform === "win32") {
    throw new Error(
      "Public Windows publication is disabled until the portable package has passed " +
      "physical install/launch/CUDA acceptance and a supported signed installer/update path exists.",
    );
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
  const activeTarget = path.resolve("resources/native/macos/active-target");
  const binaries = [...collectMachOFiles(runtimeRoot), activeTarget]
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
    normalizedPath.endsWith("/Contents/Resources/native/macos/active-target");
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
  if (process.platform === "darwin") {
    return [
      "worker",
      "resources/model-manifest",
      "resources/python-runtime",
      "resources/native",
    ];
  }
  if (process.platform === "win32") {
    return [
      "worker",
      "resources/model-manifest",
      "resources/python-runtime-windows",
      "resources/native",
      "resources/branding",
    ];
  }
  return [];
}

function resourcesPathInStaging(
  stagingPath: string,
  platform: PackagedPlatform,
): string {
  return platform === "darwin"
    ? path.join(stagingPath, MAC_APP_NAME, "Contents", "Resources")
    : path.join(stagingPath, "resources");
}

function packagedResourcesPath(outputPath: string, platform: PackagedPlatform): string {
  if (platform === "darwin") {
    const appPath = outputPath.endsWith(".app")
      ? outputPath
      : path.join(outputPath, MAC_APP_NAME);
    return path.join(appPath, "Contents", "Resources");
  }
  return path.join(outputPath, "resources");
}

function assertSourceResources(platform: PackagedPlatform, arch: string): void {
  const policy = resourcePolicyFor(platform, arch);
  const required = [
    path.resolve(policy.workerDirectory, "__init__.py"),
    path.resolve(policy.workerDirectory, "__main__.py"),
    path.resolve("resources", policy.runtimeExecutable),
    ...policy.helperFiles.map((entry) => path.resolve("resources", entry)),
    ...policy.manifestFiles.map((entry) => path.resolve("resources", entry)),
    ...policy.brandingFiles.map((entry) => path.resolve("resources", entry)),
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

function verifyAuthenticode(filePath: string): void {
  const script = [
    "$signature = Get-AuthenticodeSignature -LiteralPath $args[0]",
    "if ($signature.Status -ne 'Valid') {",
    "  throw \"Invalid Authenticode signature: $($signature.Status)\"",
    "}",
  ].join("; ");
  execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script, filePath],
    { stdio: "inherit" },
  );
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    prune: true,
    icon: process.platform === "darwin"
      ? path.resolve("resources/branding/LocalScribe.icns")
      : process.platform === "win32"
        ? path.resolve("resources/branding/LocalScribe.ico")
        : undefined,
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
            if (platform !== "darwin" && platform !== "win32") {
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
          if (platform !== "darwin" && platform !== "win32") {
            throw new Error(`Unsupported package platform: ${platform}`);
          }
          const resourcesPath = resourcesPathInStaging(stagingPath, platform);
          prunePackagedResources(resourcesPath, platform, arch);
          prunePackagedNativeModules(resourcesPath, platform, arch);

          if (platform === "darwin") {
            const infoPlist = path.join(stagingPath, MAC_APP_NAME, "Contents", "Info.plist");
            removeInfoPlistKeyIfPresent(infoPlist, "NSAppTransportSecurity.NSAllowsArbitraryLoads");
            removeInfoPlistKeyIfPresent(infoPlist, "NSBluetoothAlwaysUsageDescription");
            removeInfoPlistKeyIfPresent(infoPlist, "NSBluetoothPeripheralUsageDescription");
            removeInfoPlistKeyIfPresent(infoPlist, "NSCameraUsageDescription");
          }

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
    appCopyright: "Copyright © 2026 Devesh. All rights reserved.",
    win32metadata: {
      CompanyName: "Devesh",
      FileDescription: "Private local-first desktop dictation",
      ProductName: PRODUCT_NAME,
      InternalName: PRODUCT_NAME,
      OriginalFilename: WINDOWS_EXE_NAME,
      "requested-execution-level": "asInvoker",
    },
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
      makeBuildStartedAtMs = Date.now();
      if (process.platform !== "win32") return;
      clearWindowsMakerOutput(
        path.resolve("."),
        path.relative(path.resolve("."), WINDOWS_RELEASE.makerDirectory),
      );
      clearWindowsMakerOutput(
        path.resolve("."),
        path.join(
          "out",
          "make",
          "squirrel.windows",
          WINDOWS_RELEASE.target.arch,
        ),
      );
    },
    prePackage: async (_config, platform, arch) => {
      packageBuildStartedAtMs = Date.now();
      if (platform === "darwin") {
        const targetArchitecture =
          arch === MAC_RELEASE.target.arch ? MAC_RELEASE.target.arch : null;
        if (!targetArchitecture) throw new Error(`Unsupported macOS helper architecture: ${arch}`);
        execFileSync("xcrun", [
          "swiftc",
          "-O",
          "-target",
          `${targetArchitecture}-apple-macos${RELEASE_METADATA.minimumMacOSVersion}`,
          path.resolve("resources/native/macos/active-target.swift"),
          "-o",
          path.resolve("resources/native/macos/active-target"),
        ], { stdio: "inherit" });
        signProtectedMacResources();
      }
      if (platform !== "darwin" && platform !== "win32") {
        throw new Error(`LocalScribe cannot be packaged for ${platform}.`);
      }
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
    },
    postPackage: async (_config, result) => {
      try {
        if (result.platform !== "darwin" && result.platform !== "win32") {
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

          if (result.platform === "darwin") {
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
          } else if (PUBLIC_RELEASE) {
            verifyAuthenticode(path.join(outputPath, WINDOWS_EXE_NAME));
            verifyAuthenticode(
              path.join(outputPath, "resources", "native", "windows", "active-target.exe"),
            );
          }
        }
      } finally {
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

      const windowsArtifacts = makeResults
        .filter((result) => result.platform === "win32")
        .flatMap((result) => result.artifacts);
      if (windowsArtifacts.length > 0) {
        const portableZips = windowsArtifacts.filter((artifact) => artifact.endsWith(".zip"));
        if (portableZips.length !== 1) {
          throw new Error(
            `Windows make expected one portable ZIP; received ${portableZips.length}.`,
          );
        }
        assertFreshOrdinaryArtifact(portableZips[0]!, makeBuildStartedAtMs);
        execFileSync(
          process.execPath,
          [
            path.resolve("scripts/verify-windows-portable.mjs"),
            WINDOWS_RELEASE.packageDirectory,
            portableZips[0]!,
          ],
          { stdio: "inherit" },
        );

        const installers = windowsArtifacts.filter((artifact) => /Setup\.exe$/i.test(artifact));
        const packages = windowsArtifacts.filter((artifact) => artifact.endsWith(".nupkg"));
        const releases = windowsArtifacts.filter(
          (artifact) => path.basename(artifact).toUpperCase() === "RELEASES",
        );
        if (BUILD_LEGACY_SQUIRREL) {
          if (installers.length !== 1 || packages.length !== 1 || releases.length !== 1) {
            throw new Error(
              "Opt-in legacy Squirrel make expected exactly one Setup.exe, .nupkg, and RELEASES.",
            );
          }
          for (const artifact of [installers[0]!, packages[0]!, releases[0]!]) {
            assertFreshOrdinaryArtifact(artifact, makeBuildStartedAtMs);
          }
          execFileSync(
            process.execPath,
            [
              path.resolve("scripts/verify-squirrel-artifacts.mjs"),
              installers[0]!,
              packages[0]!,
              releases[0]!,
            ],
            { stdio: "inherit" },
          );
        } else if (installers.length > 0 || packages.length > 0 || releases.length > 0) {
          throw new Error(
            "Unsupported Squirrel artifacts appeared in the portable-only Windows build.",
          );
        }
      }
      makeBuildStartedAtMs = 0;
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
    new MakerZIP({}, ["darwin", "win32"]),
    ...(BUILD_LEGACY_SQUIRREL
      ? [
          new MakerSquirrel({
            name: "localscribe",
            authors: "Devesh",
            owners: "Devesh",
            description: "Private local-first desktop dictation",
            exe: WINDOWS_EXE_NAME,
            setupExe: `${PRODUCT_NAME}-Setup.exe`,
            setupIcon: path.resolve("resources/branding/LocalScribe.ico"),
            noMsi: true,
          }, ["win32"]),
        ]
      : []),
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
