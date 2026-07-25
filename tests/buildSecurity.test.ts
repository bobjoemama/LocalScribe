import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

function projectFile(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8").replace(/\r\n?/gu, "\n");
}

describe("release hardening configuration", () => {
  it("pins the clean-install toolchain and fail-closes unreviewed dependency scripts", () => {
    const packageJson = JSON.parse(projectFile("package.json")) as {
      packageManager?: string;
      allowScripts?: Record<string, boolean>;
      scripts?: Record<string, string>;
    };
    const localVerification = projectFile("scripts/verify-local-source.mjs");

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
    expect(packageJson.scripts?.["verify:local"]).toBe(
      "node scripts/verify-local-source.mjs",
    );
    expect(packageJson.scripts?.["verify:local:macos"]).toBe(
      "bash scripts/verify-local-macos.sh",
    );
    expect(packageJson.scripts?.["verify:windows:source"]).toBe(
      "node scripts/verify-windows-source.mjs",
    );
    expect(packageJson.scripts?.["verify:local:windows"]).toBe(
      "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-local-windows.ps1",
    );
    expect(packageJson.scripts?.["audit:production"]).toBe(
      "npm audit --omit=dev --audit-level=high",
    );
    expect(packageJson.scripts?.["audit:all"]).toBe(
      "node scripts/audit-npm-all.mjs",
    );
    expect(localVerification).toContain("process.env.npm_execpath");
    expect(localVerification).toContain("isAbsolute(npmExecPath)");
    expect(localVerification).toContain(
      "spawnSync(process.execPath, [npmExecPath, ...arguments_]",
    );
    expect(localVerification).not.toContain("npm.cmd");
    expect(localVerification).not.toContain("shell: true");
    for (const command of [
      '["run", "toolchain:verify"]',
      '["run", "audit:production"]',
      '["run", "audit:all"]',
      '["run", "worker:check-locks"]',
      '["run", "audit:python"]',
      '["run", "verify:windows:source"]',
      '["run", "lint:all"]',
      '["run", "worker:test:windows"]',
      '["run", "typecheck"]',
      '["test", "--", "--reporter=dot"]',
    ]) {
      expect(localVerification).toContain(command);
    }
    expect(projectFile("scripts/verify-npm-version.mjs")).toContain(
      "actualVersion !== expectedVersion",
    );
    expect(existsSync(resolve(root, ".github/workflows/ci.yml"))).toBe(false);
    expect(existsSync(resolve(root, ".github/workflows/release.yml"))).toBe(false);
  });

  it("cross-checks Windows npm and Python locks before target-machine packaging", () => {
    const packageJson = JSON.parse(projectFile("package.json")) as {
      scripts: Record<string, string>;
    };
    const windowsVerification = projectFile("scripts/verify-windows-source.mjs");
    const packageLock = projectFile("package-lock.json");

    expect(windowsVerification).toContain("process.env.npm_execpath");
    expect(windowsVerification).toContain("isAbsolute(npmExecPath)");
    expect(windowsVerification).toContain("command: process.execPath");
    expect(windowsVerification).toContain("npmExecPath");
    expect(windowsVerification).not.toContain("npm.cmd");
    expect(windowsVerification).not.toContain("shell: true");
    expect(packageJson.scripts["worker:test:windows"]).toContain(
      "uv run --project worker/windows_transformers --locked",
    );
    expect(packageJson.scripts["lint:python:windows"]).toContain(
      "worker/windows_transformers/localscribe_windows_worker",
    );
    expect(packageJson.scripts["lint:all"]).toContain("lint:python:windows");
    for (const expected of [
      '"ci"',
      '"--dry-run"',
      '"--strict-allow-scripts"',
      '"--os=win32"',
      '"--cpu=x64"',
      '"--python-platform"',
      '"x86_64-pc-windows-msvc"',
      '"--no-build"',
      '"--locked"',
    ]) {
      expect(windowsVerification).toContain(expected);
    }
    expect(packageLock).toContain('"node_modules/@emnapi/core"');
    expect(packageLock).toContain('"node_modules/@emnapi/runtime"');
  });

  it("provides a complete target-machine Windows and CUDA verification gate", () => {
    const windowsVerification = projectFile("scripts/verify-local-windows.ps1");
    const cudaSmoke = projectFile("scripts/smoke-windows-cuda.py");

    for (const expected of [
      "& $NodeExecutable $NpmCli run verify:local",
      '".nvmrc"',
      "Node version mismatch",
      "& $NodeExecutable $NpmCli run make:windows",
      "& $NodeExecutable $NpmCli run smoke:packaged:windows",
      "worker\\windows_transformers\\tests",
      "sbom:runtime:windows",
      "sbom:python:windows",
      "$Release.checksumPath",
      "$Release.makerDirectory",
      "verify-release-assets.mjs --platform win32",
      "Get-AuthenticodeSignature",
      "$RequireCuda",
      "$CudaModelRoot",
      "scripts\\smoke-windows-cuda.py",
    ]) {
      expect(windowsVerification).toContain(expected);
    }
    expect(cudaSmoke).toContain("get_cuda_device_count");
    expect(cudaSmoke).toContain('get_supported_compute_types("cuda", 0)');
    expect(cudaSmoke).toContain("query_device_info()");
    expect(cudaSmoke).toContain("FasterWhisperRuntime.load");
    expect(cudaSmoke).toContain('"--model-root"');
    expect(cudaSmoke).toContain('"ctranslate2", "4.8.1"');
    expect(cudaSmoke).toContain('"faster-whisper", "1.2.1"');
  });

  it("uses narrow macOS entitlements and strips Electron's unused permission declarations", () => {
    const mainEntitlements = projectFile("resources/entitlements.mac.plist");
    const helperEntitlements = projectFile("resources/entitlements.mac.helper.plist");
    const pluginEntitlements = projectFile("resources/entitlements.mac.plugin.plist");
    const activeTargetEntitlements = projectFile(
      "resources/entitlements.mac.active-target.plist",
    );
    const runtimeEntitlements = projectFile("resources/entitlements.mac.runtime.plist");
    const forgeConfig = projectFile("forge.config.ts");
    const entitlementVerifier = projectFile("scripts/verify-macos-entitlements.mjs");

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
      expect(runtimeEntitlements).not.toContain(forbidden);
    }
    expect(activeTargetEntitlements).toContain("<dict/>");
    expect(activeTargetEntitlements).not.toContain("<key>");
    expect(runtimeEntitlements).toContain("<dict/>");
    expect(runtimeEntitlements).not.toContain("<key>");
    expect(forgeConfig).toContain("MAC_ACTIVE_TARGET_ENTITLEMENTS");
    expect(forgeConfig).toContain("MAC_RUNTIME_ENTITLEMENTS");
    expect(forgeConfig).toContain("signProtectedMacResources();");
    expect(forgeConfig).toContain("ignore: isPreSignedProtectedMacResource");
    expect(forgeConfig).toContain("codesign\", [\"--verify\", \"--strict\", binary]");
    expect(forgeConfig).toContain(
      'normalizedPath.endsWith("/native/macos/active-target")',
    );
    expect(forgeConfig).toContain('normalizedPath.includes("/python-runtime/")');
    expect(forgeConfig).toContain("verify-macos-entitlements.mjs");
    expect(entitlementVerifier).toContain("assertNoEntitlementKeys(activeTarget)");
    expect(entitlementVerifier).toContain(
      "for (const binary of runtimeMachOFiles) assertNoEntitlementKeys(binary)",
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

  it("forbids renderer document embedding, object loading, base rewriting, and form egress", () => {
    const rendererDocument = projectFile("index.html");

    for (const directive of [
      "base-uri 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "form-action 'none'",
    ]) {
      expect(rendererDocument).toContain(directive);
    }
    expect(rendererDocument).toContain("script-src 'self'");
    expect(rendererDocument).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(rendererDocument).not.toContain("script-src 'self' 'unsafe-eval'");
  });

  it("anchors CommonJS require to Electron's absolute app path", () => {
    const main = projectFile("src/main.ts");
    const verifier = projectFile("scripts/verify-packaged-main.mjs");
    const macSmoke = projectFile("scripts/smoke-packaged-macos.sh");
    const windowsSmoke = projectFile("scripts/smoke-packaged-windows.ps1");

    expect(main).not.toMatch(/createRequire\s*\(\s*import\.meta\.url\s*\)/u);
    expect(main).toContain(
      'createRequire(path.join(app.getAppPath(), "package.json"))',
    );
    expect(main).toContain('appRequire("electron-squirrel-startup")');
    expect(verifier).toContain(
      'path.join(".vite", "build", "main.js")',
    );
    expect(verifier).not.toContain(
      'extractFile(resolvedAsarPath, ".vite/build/main.js")',
    );
    expect(verifier).toContain("Packaged Electron main contains an import.meta.url");
    expect(macSmoke).toContain("verify-packaged-main.mjs");
    expect(windowsSmoke).toContain("verify-packaged-main.mjs");
    expect(windowsSmoke).toContain("Stop-SmokeProcessTree");
    expect(windowsSmoke).toContain('"/T", "/F"');
    expect(windowsSmoke).toContain("Remove-SmokeDirectory");
    expect(windowsSmoke).toContain("$Attempt -le 10");
  });

  it("waits for interrupted startup before closing the local database", () => {
    const main = projectFile("src/main.ts");
    const beforeQuit = main.slice(main.indexOf('app.on("before-quit"'));

    expect(main).toContain("startupPromise = app.whenReady().then");
    expect(main).toContain("await startupPromise;");
    expect(main).toContain("if (quitting) return;");
    expect(beforeQuit).toContain("worker.abort(\"LocalScribe is quitting\")");
    expect(beforeQuit).toContain("void finishShutdown()");
    expect(beforeQuit).not.toContain("database.close()");
    expect(main).toContain('window.once("session-end"');
    expect(main).toContain("if (!beginShutdown()) return;");
    expect(main).toContain("runtimeReleasePromise ??=");
    expect(main).toContain('if (quitting) throw new Error("LocalScribe is shutting down")');
  });

  it("binds every platform-pruned loose resource to an expectation bundled in app.asar", () => {
    const forgeConfig = projectFile("forge.config.ts");
    const integrity = projectFile("src/main/resourceIntegrity.ts");
    const generated = projectFile("src/main/generatedResourceIntegrity.ts");

    expect(forgeConfig).toContain("prepareGeneratedResourceIntegrity");
    expect(forgeConfig).toContain("assertPackagedResourceIntegrity(");
    expect(forgeConfig).toContain("resourceIntegrityPreparation?.restore()");
    expect(integrity).toContain("verifyPackagedResourceIntegrity");
    expect(integrity).toContain("Resource integrity found an unexpected loose resource");
    expect(integrity).toContain("process.once(\"exit\"");
    expect(generated).toContain("generatedResourceIntegrity");
    expect(generated).not.toContain("sha256");
  });

  it("prunes and verifies the packaged dependency inventory", () => {
    const forgeConfig = projectFile("forge.config.ts");

    expect(forgeConfig).toContain('file === "/package.json"');
    expect(forgeConfig).toContain("pruneStagedNodeModules(buildPath)");
    expect(forgeConfig).toContain("prunePackagedResources(resourcesPath, platform, arch)");
    expect(forgeConfig).toContain("prunePackagedNativeModules(resourcesPath, platform, arch)");
    expect(forgeConfig).toContain("assertPackagedAppInventory(resourcesPath, platform, arch)");
    expect(forgeConfig).toContain("assertPackagedAppInventory(resourcesPath, result.platform, result.arch)");
  });

  it("keeps public signing fail-closed while permitting clearly non-release local builds", () => {
    const forgeConfig = projectFile("forge.config.ts");

    expect(forgeConfig).toContain('process.env.LOCALSCRIBE_RELEASE === "1"');
    expect(forgeConfig).toContain('startsWith("Developer ID Application:")');
    expect(forgeConfig).toContain('requireReleaseEnvironment("APPLE_KEYCHAIN_PROFILE")');
    expect(forgeConfig).toContain('"--keychain-profile"');
    expect(forgeConfig).not.toContain("APPLE_APP_SPECIFIC_PASSWORD");
    expect(forgeConfig).not.toContain('"--password"');
    expect(forgeConfig).toContain("Public Windows publication is disabled");
    expect(forgeConfig).not.toContain("WINDOWS_CERTIFICATE_PASSWORD");
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
    expect(projectFile("vite.preload.config.ts")).toContain(
      "delete outputOptions.inlineDynamicImports",
    );
    expect(projectFile("vite.preload.config.ts")).toContain(
      "outputOptions.codeSplitting = false",
    );
  });

  it("builds both worker runtimes from their committed uv locks", () => {
    const macBuild = projectFile("scripts/build-worker-runtime.sh");
    const windowsBuild = projectFile("scripts/build-worker-runtime.ps1");

    for (const buildScript of [macBuild, windowsBuild]) {
      expect(buildScript).toContain("3.12.13");
      expect(buildScript).toContain("--locked");
      expect(buildScript).toContain("--no-editable");
      expect(buildScript).not.toContain("uv pip install");
    }
    expect(macBuild).toContain('"$uv_bin" sync');
    expect(macBuild).toContain('"$uv_bin" lock --check');
    expect(macBuild).toContain('"$project_root/.uv-version"');
    expect(windowsBuild).toContain(
      '$UvVersion = (Get-Content -LiteralPath (Join-Path $ProjectRoot ".uv-version") -Raw).Trim()',
    );
    expect(windowsBuild).toContain('-Arguments @("lock", "--check", "--project", $WorkerRoot)');
    expect(windowsBuild).toContain('"sync",');
    expect(windowsBuild).toContain("Invoke-Checked");
    expect(windowsBuild).toContain("Existing Windows runtime root");
    expect(windowsBuild).toContain(".python-runtime-windows-build-");
    expect(windowsBuild).toContain("Recover-StaleTransactions");
    expect(windowsBuild).toContain("Cannot recover Windows runtime because multiple owned backups exist");
    expect(windowsBuild).toContain("Move-Item -LiteralPath $StagingRoot -Destination $RuntimeRoot");
    const promotionBlock = windowsBuild.slice(windowsBuild.indexOf("$BackupCreated = $false"));
    expect(promotionBlock.indexOf("(Join-Path $RuntimeRoot $OwnershipMarkerName)")).toBeLessThan(
      promotionBlock.indexOf("Move-Item -LiteralPath $RuntimeRoot -Destination $BackupRoot"),
    );
    expect(macBuild).toContain("--reinstall-package localscribe-worker");
    expect(windowsBuild).toContain(
      '"--reinstall-package", "localscribe-windows-faster-whisper-worker"',
    );
    expect(windowsBuild).toContain(
      '"cpython-$PythonVersion-windows-x86_64-none"',
    );
    expect(windowsBuild.match(/FileAttributes\]::ReparsePoint/g)?.length).toBeGreaterThanOrEqual(3);
    expect(windowsBuild.match(/ForEach-Object \{ \$_\.Delete\(\) \}/g)).toHaveLength(2);
    expect(
      windowsBuild.match(
        /\(\$_\.Attributes -band \[IO\.FileAttributes\]::ReparsePoint\) -ne 0\s*\}\s*\|\s*ForEach-Object \{ \$_\.Delete\(\) \}/gu,
      ),
    ).toHaveLength(1);
    expect(windowsBuild).toContain(
      "Relocatable runtime still contains non-portable reparse points",
    );
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
    expect(windowsHelperBuild).toContain('"/analyze"');
    expect(windowsHelperBuild).toContain('"/HIGHENTROPYVA"');
    expect(windowsHelperBuild).toContain('"/DEPENDENTLOADFLAG:0x800"');
    expect(windowsHelperBuild).toContain(
      'Join-Path ([Environment]::SystemDirectory) "cmd.exe"',
    );
    expect(windowsHelperBuild).not.toContain("$env:ComSpec");
    expect(windowsHelperBuild).not.toContain("${env:ProgramFiles(x86)}");
    expect(windowsHelperBuild).not.toContain("$env:VSCMD_ARG_TGT_ARCH");
    expect(windowsHelperBuild).toContain("Get-AuthenticodeSignature");
    expect(windowsHelperBuild).toContain("CN=Microsoft Corporation");
    for (const variable of ["CL", "_CL_", "LINK", "_LINK_", "INCLUDE", "LIB", "LIBPATH"]) {
      expect(windowsHelperBuild).toContain(`"${variable}"`);
    }
    expect(windowsHelperBuild).toContain(
      "Push-Location -LiteralPath $temporaryDirectory",
    );
    expect(windowsHelperBuild).toContain("[IO.FileAttributes]::ReparsePoint");
    expect(windowsHelperBuild).toContain(
      "The helper output path must not overwrite its source file.",
    );
    expect(windowsHelperBuild).not.toContain(
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    );
    expect(windowsHelperSource.indexOf("#include <unknwn.h>")).toBeLessThan(
      windowsHelperSource.indexOf("#include <uiautomation.h>"),
    );
    expect(windowsHelperSource.indexOf("#include <objbase.h>")).toBeLessThan(
      windowsHelperSource.indexOf("#include <uiautomation.h>"),
    );
    const environmentImport = windowsHelperBuild.indexOf(
      "if (-not (Import-X64VisualCppEnvironment))",
    );
    const postImportArgumentClear = windowsHelperBuild.indexOf(
      'foreach ($injectedArgumentVariable in @("CL", "_CL_", "LINK", "_LINK_"))',
      environmentImport,
    );
    const compilerResolution = windowsHelperBuild.indexOf(
      'Resolve-TrustedMicrosoftBuildTool -Name "cl.exe"',
    );
    expect(environmentImport).toBeGreaterThan(-1);
    expect(postImportArgumentClear).toBeGreaterThan(environmentImport);
    expect(compilerResolution).toBeGreaterThan(postImportArgumentClear);
    expect(windowsHelperSource).toContain(
      "has_keyboard_focus != FALSE &&\n          !runtime_id->empty()",
    );
    expect(windowsHelperSource).toContain(
      "!explicitly_read_only &&\n      NativeControlLooksEditable",
    );
    expect(windowsHelperSource).toContain(
      "GetForegroundWindow() != target.foreground_window",
    );
    expect(windowsHelperSource).toContain(
      "GetClipboardSequenceNumber() != expectation.clipboard_sequence",
    );
    expect(windowsHelperSource.match(/IsKeyPressed\(VK_SHIFT\)/g)).toHaveLength(2);
    expect(windowsHelperSource).toContain("IsKeyPressed(VK_LWIN)");
    expect(windowsHelperSource).toContain("IsKeyPressed(VK_RWIN)");
  });

  it("audits every exact worker package with a separately locked pip-audit", () => {
    const packageJson = projectFile("package.json");
    const auditScript = projectFile("scripts/audit-python-deps.mjs");
    const auditToolProject = projectFile("tools/python-audit/pyproject.toml");
    const auditToolLock = projectFile("tools/python-audit/uv.lock");
    const localVerification = projectFile("scripts/verify-local-source.mjs");

    expect(packageJson).toContain('"audit:python": "node scripts/audit-python-deps.mjs"');
    expect(packageJson).toContain("uv lock --check --project tools/python-audit");
    expect(auditToolProject).toContain('"pip-audit==2.10.1"');
    expect(auditToolLock).toContain('name = "pip-audit"');
    expect(auditToolLock).toContain('version = "2.10.1"');
    expect(auditScript).toContain('const auditToolProject = "tools/python-audit"');
    expect(auditScript).not.toContain("PIP_AUDIT_VERSION");
    expect(auditScript).not.toContain('"tool"');
    expect(auditScript).toContain('"python",\n      "-m",\n      "pip_audit"');
    expect(auditScript).not.toContain('"pip-audit",');
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
    expect(localVerification.match(/"audit:python"/g)).toHaveLength(1);
  });

  it("runs every local macOS gate in fail-fast order and verifies its artifacts", () => {
    const localMacVerification = projectFile("scripts/verify-local-macos.sh");
    const sourceIndex = localMacVerification.indexOf("npm run verify:local");
    const makeIndex = localMacVerification.indexOf("npm run make:mac");
    const smokeIndex = localMacVerification.indexOf("npm run smoke:packaged:macos");

    expect(sourceIndex).toBeGreaterThan(-1);
    expect(makeIndex).toBeGreaterThan(sourceIndex);
    expect(smokeIndex).toBeGreaterThan(makeIndex);
    expect(localMacVerification).toContain("PYTHONDONTWRITEBYTECODE=1");
    expect(localMacVerification).toContain("-m unittest discover -s worker/tests -v");
    expect(localMacVerification).toContain("npm run --silent sbom:runtime:macos");
    expect(localMacVerification).toContain("npm run --silent sbom:python:macos");
    expect(localMacVerification).toContain("checksum_path");
    expect(localMacVerification).toContain(
      'shasum -a 256 -c "$(basename "$checksum_path")"',
    );
    expect(localMacVerification).toContain(
      "verify-release-assets.mjs --platform darwin",
    );
    expect(localMacVerification).toContain("codesign --verify --deep --strict");
    expect(localMacVerification).toContain("verify-macos-entitlements.mjs");
    expect(localMacVerification).not.toMatch(/npm run sbom/u);
  });

  it("scopes explicit MLX license approval to the signed macOS build", () => {
    const localMacVerification = projectFile("scripts/verify-local-macos.sh");
    const forgeConfig = projectFile("forge.config.ts");

    expect(localMacVerification).not.toContain(
      "LOCALSCRIBE_UNDECLARED_MLX_LICENSE_APPROVED",
    );
    expect(forgeConfig).toContain(
      'process.env.LOCALSCRIBE_UNDECLARED_MLX_LICENSE_APPROVED !== "1"',
    );
    expect(forgeConfig).toContain(
      "Public macOS releases require documented legal approval",
    );
  });
});
