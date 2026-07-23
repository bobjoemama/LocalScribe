import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

function projectFile(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("release hardening configuration", () => {
  it("pins the clean-install toolchain and fail-closes unreviewed dependency scripts", () => {
    const packageJson = JSON.parse(projectFile("package.json")) as {
      packageManager?: string;
      allowScripts?: Record<string, boolean>;
    };
    const ciWorkflow = projectFile(".github/workflows/ci.yml");
    const releaseWorkflow = projectFile(".github/workflows/release.yml");

    expect(packageJson.packageManager).toBe("npm@11.16.0");
    expect(projectFile("package.json")).toContain('"@electron/rebuild": "4.2.0"');
    expect(packageJson.allowScripts).toEqual({
      "better-sqlite3@13.0.1": true,
      "electron-winstaller@5.4.4": true,
      "fs-xattr@0.3.1": true,
      fsevents: false,
      "macos-alias@0.2.12": true,
      "uiohook-napi@1.5.5": true,
    });
    expect(ciWorkflow.match(/node-version: "24\.18\.0"/g)).toHaveLength(2);
    expect(releaseWorkflow.match(/node-version: "24\.18\.0"/g)).toHaveLength(3);
    expect(ciWorkflow.match(/npm ci --strict-allow-scripts/g)).toHaveLength(2);
    expect(releaseWorkflow.match(/npm ci --strict-allow-scripts/g)).toHaveLength(3);
    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      const actions = [...workflow.matchAll(/^\s*uses:\s*(\S+)/gmu)]
        .map((match) => match[1]);
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) {
        expect(action).toMatch(/@[a-f0-9]{40}$/u);
      }
    }
  });

  it("uses narrow macOS entitlements and strips Electron's unused permission declarations", () => {
    const mainEntitlements = projectFile("resources/entitlements.mac.plist");
    const helperEntitlements = projectFile("resources/entitlements.mac.helper.plist");
    const pluginEntitlements = projectFile("resources/entitlements.mac.plugin.plist");
    const activeTargetEntitlements = projectFile(
      "resources/entitlements.mac.active-target.plist",
    );
    const forgeConfig = projectFile("forge.config.ts");

    expect(mainEntitlements).toContain("com.apple.security.cs.allow-jit");
    expect(mainEntitlements).toContain("com.apple.security.device.audio-input");
    for (const forbidden of [
      "camera",
      "bluetooth",
      "usb",
      "print",
      "location",
      "NSAllowsArbitraryLoads",
    ]) {
      expect(mainEntitlements).not.toContain(forbidden);
      expect(helperEntitlements).not.toContain(forbidden);
      expect(pluginEntitlements).not.toContain(forbidden);
      expect(activeTargetEntitlements).not.toContain(forbidden);
    }
    expect(activeTargetEntitlements).toContain("<dict/>");
    expect(activeTargetEntitlements).not.toContain("<key>");
    expect(forgeConfig).toContain("MAC_ACTIVE_TARGET_ENTITLEMENTS");
    expect(forgeConfig).toContain(
      'normalizedPath.endsWith("/Contents/Resources/native/macos/active-target")',
    );

    expect(forgeConfig).toContain('removeInfoPlistKeyIfPresent(infoPlist, "NSAppTransportSecurity.NSAllowsArbitraryLoads")');
    expect(forgeConfig).toContain('removeInfoPlistKeyIfPresent(infoPlist, "NSBluetoothAlwaysUsageDescription")');
    expect(forgeConfig).toContain('removeInfoPlistKeyIfPresent(infoPlist, "NSCameraUsageDescription")');
  });

  it("hardens the Electron fuse configuration without dropping ASAR protections", () => {
    const forgeConfig = projectFile("forge.config.ts");

    expect(forgeConfig).toContain("[FuseV1Options.GrantFileProtocolExtraPrivileges]: false");
    expect(forgeConfig).toContain("[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true");
    expect(forgeConfig).toContain("[FuseV1Options.OnlyLoadAppFromAsar]: true");
  });

  it("prunes and verifies the packaged dependency inventory", () => {
    const forgeConfig = projectFile("forge.config.ts");

    expect(forgeConfig).toContain('file === "/package.json"');
    expect(forgeConfig).toContain("pruneStagedNodeModules(buildPath)");
    expect(forgeConfig).toContain("prunePackagedResources(resourcesPath, platform, arch)");
    expect(forgeConfig).toContain("assertPackagedAppInventory(resourcesPath, platform, arch)");
    expect(forgeConfig).toContain("assertPackagedAppInventory(resourcesPath, result.platform, result.arch)");
  });

  it("keeps public signing fail-closed while permitting clearly non-release local builds", () => {
    const forgeConfig = projectFile("forge.config.ts");

    expect(forgeConfig).toContain('process.env.LOCALSCRIBE_RELEASE === "1"');
    expect(forgeConfig).toContain('startsWith("Developer ID Application:")');
    expect(forgeConfig).toContain('requireReleaseEnvironment("APPLE_APP_SPECIFIC_PASSWORD")');
    expect(forgeConfig).toContain('requireReleaseEnvironment("WINDOWS_TIMESTAMP_SERVER")');
    expect(forgeConfig).toContain('execFileSync("codesign", ["--verify"');
    expect(forgeConfig).toContain('execFileSync("spctl", ["--assess"');
    expect(forgeConfig).toContain("verifyAuthenticode");
  });

  it("does not emit source maps unless a private diagnostic build opts in", () => {
    for (const config of [
      "vite.main.config.ts",
      "vite.preload.config.ts",
      "vite.renderer.config.ts",
    ]) {
      const source = projectFile(config);
      expect(source).toContain('process.env.LOCALSCRIBE_PRIVATE_SOURCEMAPS === "1"');
      expect(source).not.toContain("sourcemap: true");
    }
  });

  it("builds both worker runtimes from their committed uv locks", () => {
    const macBuild = projectFile("scripts/build-worker-runtime.sh");
    const windowsBuild = projectFile("scripts/build-worker-runtime.ps1");

    for (const buildScript of [macBuild, windowsBuild]) {
      expect(buildScript).toContain("3.12.13");
      expect(buildScript).toContain("uv sync");
      expect(buildScript).toContain("--locked");
      expect(buildScript).toContain("--no-editable");
      expect(buildScript).toContain("uv lock --check");
      expect(buildScript).not.toContain("uv pip install");
    }
  });

  it("resolves the Windows helper output only after PowerShell initializes the script path", () => {
    const windowsHelperBuild = projectFile("resources/native/windows/build.ps1");
    const windowsHelperSource = projectFile("resources/native/windows/active-target.cpp");
    const parameterBlock = windowsHelperBuild.slice(
      windowsHelperBuild.indexOf("param("),
      windowsHelperBuild.indexOf("$ErrorActionPreference"),
    );

    expect(parameterBlock).not.toContain("$PSScriptRoot");
    expect(windowsHelperBuild).toContain(
      '$OutputPath = Join-Path $PSScriptRoot "active-target.exe"',
    );
    expect(windowsHelperBuild).toContain("-prerelease");
    expect(windowsHelperBuild).toContain("VC\\Auxiliary\\Build\\vcvars64.bat");
    expect(windowsHelperBuild).not.toContain(
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    );
    expect(windowsHelperSource.indexOf("#include <unknwn.h>")).toBeLessThan(
      windowsHelperSource.indexOf("#include <uiautomation.h>"),
    );
    expect(windowsHelperSource.indexOf("#include <objbase.h>")).toBeLessThan(
      windowsHelperSource.indexOf("#include <uiautomation.h>"),
    );
  });

  it("audits every exact worker package with a separately locked pip-audit", () => {
    const packageJson = projectFile("package.json");
    const auditScript = projectFile("scripts/audit-python-deps.mjs");
    const auditToolProject = projectFile("tools/python-audit/pyproject.toml");
    const auditToolLock = projectFile("tools/python-audit/uv.lock");
    const ciWorkflow = projectFile(".github/workflows/ci.yml");
    const releaseWorkflow = projectFile(".github/workflows/release.yml");

    expect(packageJson).toContain('"audit:python": "node scripts/audit-python-deps.mjs"');
    expect(packageJson).toContain("uv lock --check --project tools/python-audit");
    expect(auditToolProject).toContain('"pip-audit==2.10.1"');
    expect(auditToolLock).toContain('name = "pip-audit"');
    expect(auditToolLock).toContain('version = "2.10.1"');
    expect(auditScript).toContain('const auditToolProject = "tools/python-audit"');
    expect(auditScript).not.toContain("PIP_AUDIT_VERSION");
    expect(auditScript).not.toContain('"tool"');
    expect(auditScript).toContain('{ label: "macOS worker", directory: "worker" }');
    expect(auditScript).toContain(
      '{ label: "Windows worker", directory: "worker/windows_transformers" }',
    );
    for (const requiredFlag of [
      '"export"',
      '"run"',
      '"--project"',
      '"--locked"',
      '"--no-dev"',
      '"--no-emit-project"',
      '"--disable-pip"',
      '"--require-hashes"',
      '"--strict"',
    ]) {
      expect(auditScript).toContain(requiredFlag);
    }
    expect(ciWorkflow.match(/npm run audit:python/g)).toHaveLength(2);
    expect(releaseWorkflow.match(/npm run audit:python/g)).toHaveLength(1);
  });

  it("verifies the exact tagged source without secrets before either signed build", () => {
    const releaseWorkflow = projectFile(".github/workflows/release.yml");
    const verifyJob = releaseWorkflow.slice(
      releaseWorkflow.indexOf("  release-verify:"),
      releaseWorkflow.indexOf("\n  macos:"),
    );
    const macJob = releaseWorkflow.slice(
      releaseWorkflow.indexOf("  macos:"),
      releaseWorkflow.indexOf("\n  windows:"),
    );
    const windowsJob = releaseWorkflow.slice(
      releaseWorkflow.indexOf("  windows:"),
    );
    const macJobHeader = releaseWorkflow.match(
      /  macos:\n((?:    .*\n)*)    steps:/u,
    )?.[1];
    const windowsJobHeader = releaseWorkflow.match(
      /  windows:\n((?:    .*\n)*)    steps:/u,
    )?.[1];

    expect(releaseWorkflow).toContain("expected_ref=\"refs/tags/v${release_version}\"");
    expect(releaseWorkflow).toContain('if [[ "$GITHUB_REF" != "$expected_ref" ]]');
    expect(releaseWorkflow.split("ref: ${{ github.sha }}")).toHaveLength(4);
    expect(releaseWorkflow.match(/needs: release-verify/g)).toHaveLength(2);
    expect(verifyJob).not.toContain("secrets.");
    expect(verifyJob).not.toContain("environment: release");
    for (const command of [
      "npm ci",
      "npm run audit:production",
      "npm run audit:all",
      "npm run worker:check-locks",
      "npm run audit:python",
      "npm run typecheck",
      "npm test -- --reporter=dot",
    ]) {
      expect(verifyJob).toContain(command);
    }
    expect(macJobHeader).toBeDefined();
    expect(macJobHeader).not.toContain("secrets.");
    expect(windowsJobHeader).toBeDefined();
    expect(windowsJobHeader).not.toContain("secrets.");
    expect(macJob.indexOf("- name: Install dependencies")).toBeLessThan(
      macJob.indexOf("- name: Import Developer ID certificate"),
    );
    expect(windowsJob.indexOf("- name: Install dependencies")).toBeLessThan(
      windowsJob.indexOf("- name: Materialize signing certificate"),
    );
    expect(releaseWorkflow).toContain(
      "MACOS_CERTIFICATE_P12_BASE64: ${{ secrets.MACOS_CERTIFICATE_P12_BASE64 }}",
    );
    expect(releaseWorkflow).toContain(
      "WINDOWS_CERTIFICATE_PASSWORD: ${{ secrets.WINDOWS_CERTIFICATE_PASSWORD }}",
    );
  });

  it("writes parseable SBOM streams without npm lifecycle banners", () => {
    const ciWorkflow = projectFile(".github/workflows/ci.yml");
    const releaseWorkflow = projectFile(".github/workflows/release.yml");

    expect(ciWorkflow.match(/npm run --silent sbom/g)).toHaveLength(2);
    expect(releaseWorkflow.match(/npm run --silent sbom/g)).toHaveLength(2);
    expect(`${ciWorkflow}\n${releaseWorkflow}`).not.toMatch(/npm run sbom/);
  });
});
