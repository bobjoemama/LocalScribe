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
  assertPackagedResourceIntegrity,
  prepareGeneratedResourceIntegrity,
  type PreparedResourceIntegrity,
} from "./src/main/resourceIntegrity";

const APP_BUNDLE_ID = "com.localscribe.desktop";
const MAC_ENTITLEMENTS = path.resolve("resources/entitlements.mac.plist");
const MAC_HELPER_ENTITLEMENTS = path.resolve("resources/entitlements.mac.helper.plist");
const MAC_PLUGIN_ENTITLEMENTS = path.resolve("resources/entitlements.mac.plugin.plist");
const MAC_ACTIVE_TARGET_ENTITLEMENTS = path.resolve(
  "resources/entitlements.mac.active-target.plist",
);
const MAC_RUNTIME_ENTITLEMENTS = path.resolve("resources/entitlements.mac.runtime.plist");
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

function validatePublicReleaseConfiguration(): void {
  if (!PUBLIC_RELEASE) return;
  if (process.platform === "darwin") {
    if (!MAC_SIGNING_IDENTITY.startsWith("Developer ID Application:")) {
      throw new Error(
        "Public macOS releases require LOCALSCRIBE_CODESIGN_IDENTITY to name a Developer ID Application identity.",
      );
    }
    requireReleaseEnvironment("APPLE_ID");
    requireReleaseEnvironment("APPLE_APP_SPECIFIC_PASSWORD");
    requireReleaseEnvironment("APPLE_TEAM_ID");
    if (process.env.LOCALSCRIBE_UNDECLARED_MLX_LICENSE_APPROVED !== "1") {
      throw new Error(
        "Public macOS releases require documented legal approval for every packaged MLX artifact with Undeclared license metadata.",
      );
    }
    return;
  }
  if (process.platform === "win32") {
    const signWithParams = process.env.WINDOWS_SIGN_WITH_PARAMS?.trim();
    if (!signWithParams) {
      requireReleaseEnvironment("WINDOWS_CERTIFICATE_FILE");
      requireReleaseEnvironment("WINDOWS_CERTIFICATE_PASSWORD");
    }
    const timestampServer = requireReleaseEnvironment("WINDOWS_TIMESTAMP_SERVER");
    if (!timestampServer.startsWith("https://")) {
      throw new Error("WINDOWS_TIMESTAMP_SERVER must use HTTPS.");
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

function windowsSignOptions(): {
  signWithParams?: string;
  certificateFile?: string;
  certificatePassword?: string;
  timestampServer: string;
  description: string;
} | undefined {
  if (!PUBLIC_RELEASE || process.platform !== "win32") return undefined;
  const timestampServer = requireReleaseEnvironment("WINDOWS_TIMESTAMP_SERVER");
  const signWithParams = process.env.WINDOWS_SIGN_WITH_PARAMS?.trim();
  return {
    ...(signWithParams
      ? { signWithParams }
      : {
          certificateFile: requireReleaseEnvironment("WINDOWS_CERTIFICATE_FILE"),
          certificatePassword: requireReleaseEnvironment("WINDOWS_CERTIFICATE_PASSWORD"),
        }),
    timestampServer,
    description: "LocalScribe",
  };
}

function resourcesPathInStaging(
  stagingPath: string,
  platform: PackagedPlatform,
): string {
  return platform === "darwin"
    ? path.join(stagingPath, "LocalScribe.app", "Contents", "Resources")
    : path.join(stagingPath, "resources");
}

function packagedResourcesPath(outputPath: string, platform: PackagedPlatform): string {
  if (platform === "darwin") {
    const appPath = outputPath.endsWith(".app")
      ? outputPath
      : path.join(outputPath, "LocalScribe.app");
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
  execFileSync(
    "xcrun",
    [
      "notarytool",
      "submit",
      dmgPath,
      "--apple-id",
      requireReleaseEnvironment("APPLE_ID"),
      "--password",
      requireReleaseEnvironment("APPLE_APP_SPECIFIC_PASSWORD"),
      "--team-id",
      requireReleaseEnvironment("APPLE_TEAM_ID"),
      "--wait",
    ],
    { stdio: "inherit" },
  );
  execFileSync("xcrun", ["stapler", "staple", dmgPath], { stdio: "inherit" });
  execFileSync("xcrun", ["stapler", "validate", dmgPath], { stdio: "inherit" });
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

const windowsSigning = windowsSignOptions();

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
      (buildPath, _electronVersion, _platform, _arch, callback) => {
        pruneStagedNodeModules(buildPath).then(
          () => callback(),
          (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
        );
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
            const infoPlist = path.join(stagingPath, "LocalScribe.app", "Contents", "Info.plist");
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
      ProductName: "LocalScribe",
      InternalName: "LocalScribe",
      OriginalFilename: "LocalScribe.exe",
      "requested-execution-level": "asInvoker",
    },
    extendInfo: {
      NSMicrophoneUsageDescription:
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
                  appleId: requireReleaseEnvironment("APPLE_ID"),
                  appleIdPassword: requireReleaseEnvironment("APPLE_APP_SPECIFIC_PASSWORD"),
                  teamId: requireReleaseEnvironment("APPLE_TEAM_ID"),
                },
              }
            : {}),
        }
      : {}),
    ...(windowsSigning ? { windowsSign: windowsSigning } : {}),
  },
  hooks: {
    prePackage: async (_config, platform, arch) => {
      if (platform === "darwin") {
        const targetArchitecture = arch === "arm64" ? "arm64" : null;
        if (!targetArchitecture) throw new Error(`Unsupported macOS helper architecture: ${arch}`);
        execFileSync("xcrun", [
          "swiftc",
          "-O",
          "-target",
          `${targetArchitecture}-apple-macos13.0`,
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
          assertPackagedAppInventory(resourcesPath, result.platform, result.arch);
          assertPackagedResourceIntegrity(
            resourcesPath,
            result.platform,
            result.arch,
            resourceIntegrityPreparation.expectation,
          );

          if (result.platform === "darwin") {
            const appPath = outputPath.endsWith(".app")
              ? outputPath
              : path.join(outputPath, "LocalScribe.app");
            execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath], {
              stdio: "inherit",
            });
            execFileSync(
              process.execPath,
              [path.resolve("scripts/verify-macos-entitlements.mjs"), appPath],
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
            verifyAuthenticode(path.join(outputPath, "LocalScribe.exe"));
            verifyAuthenticode(
              path.join(outputPath, "resources", "native", "windows", "active-target.exe"),
            );
          }
        }
      } finally {
        resourceIntegrityPreparation?.restore();
        resourceIntegrityPreparation = null;
      }
    },
    postMake: async (_config, makeResults: ForgeMakeResult[]) => {
      const macArtifacts = makeResults
        .filter((result) => result.platform === "darwin")
        .flatMap((result) => result.artifacts);
      if (macArtifacts.length > 0) {
        const dmgs = macArtifacts.filter((artifact) => artifact.endsWith(".dmg"));
        if (dmgs.length === 0) throw new Error("macOS make did not produce a DMG.");
        if (PUBLIC_RELEASE) dmgs.forEach(notarizeAndStapleDmg);
      }

      const windowsArtifacts = makeResults
        .filter((result) => result.platform === "win32")
        .flatMap((result) => result.artifacts);
      if (windowsArtifacts.length > 0) {
        const installers = windowsArtifacts.filter((artifact) => /Setup\.exe$/i.test(artifact));
        if (installers.length !== 1) {
          throw new Error(`Windows make expected one Squirrel Setup.exe; received ${installers.length}.`);
        }
        if (PUBLIC_RELEASE) installers.forEach(verifyAuthenticode);
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
    new MakerSquirrel({
      name: "localscribe",
      authors: "Devesh",
      owners: "Devesh",
      description: "Private local-first desktop dictation",
      exe: "LocalScribe.exe",
      setupExe: "LocalScribe-Setup.exe",
      setupIcon: path.resolve("resources/branding/LocalScribe.ico"),
      noMsi: true,
      ...(windowsSigning ? { windowsSign: windowsSigning } : {}),
    }, ["win32"]),
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
