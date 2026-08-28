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
      '["run", "lint:all"]',
      '["run", "typecheck"]',
      '["test", "--", "--reporter=dot"]',
    ]) {
      expect(localVerification).toContain(command);
    }
    expect(projectFile("scripts/verify-npm-version.mjs")).toContain(
      "actualVersion !== expectedVersion",
    );
    expect(existsSync(resolve(root, ".github/workflows/ci.yml"))).toBe(true);
    expect(existsSync(resolve(root, ".github/workflows/release.yml"))).toBe(false);
  });

  it("keeps hosted CI read-only, pinned, source-scoped, and active on main", () => {
    const workflow = projectFile(".github/workflows/ci.yml");

    expect(workflow).toContain("push:");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("      - main");
    expect(workflow).not.toContain("pull_request_target:");
    expect(workflow).not.toMatch(/^\s*(?:workflow_dispatch|schedule):/mu);
    expect(workflow).not.toContain("paths:");
    expect(workflow).not.toContain("paths-ignore:");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).not.toMatch(/^\s+[\w-]+: write\s*$/mu);
    expect(workflow).not.toContain("secrets:");
    expect(workflow).not.toContain("${{ secrets.");
    expect(workflow).not.toContain("upload-artifact");
    expect(workflow).not.toContain("download-artifact");
    expect(workflow).not.toContain("cache: npm");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("enable-cache: false");
    expect(workflow).toContain(
      "group: source-ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}",
    );
    expect(workflow).toContain("cancel-in-progress: true");
    expect(workflow).toContain('CI: "true"');
    expect(workflow).toContain('UV_PYTHON_DOWNLOADS: "never"');
    expect(workflow).toContain("name: Source verification");
    expect(workflow).toContain("if: ${{ github.event_name == 'push' || !github.event.pull_request.draft }}");
    expect(workflow).toContain("runs-on: macos-14");
    expect(workflow).toContain("timeout-minutes: 30");

    for (const action of [
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
      "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0",
      "astral-sh/setup-uv@20cfd1bf945f4377ade1205e4dbc17946fc9a30d # v10.0.1",
    ]) {
      expect(workflow).toContain(`uses: ${action}`);
    }
    expect(workflow.match(/^\s*uses:\s+.+$/gmu)).toHaveLength(4);
    expect(workflow).not.toMatch(/uses:\s+[^\s@]+@(?:main|master|v?\d+(?:\.\d+)*)\s*$/mu);
    expect(workflow).toContain("node-version-file: .nvmrc");
    expect(workflow).toContain("python-version: 3.12.10");
    expect(workflow).toContain('version: "0.11.11"');
    expect(projectFile(".uv-version").trim()).toBe("0.11.11");
    expect(workflow).toContain(
      "npm install --global npm@11.16.0 --ignore-scripts --no-audit --no-fund",
    );
    expect(workflow).toContain("run: npm ci --strict-allow-scripts");
    expect(workflow).toContain("run: npm run ci");
  });

  it("limits Dependabot to pinned GitHub Actions updates against main", () => {
    const dependabot = projectFile(".github/dependabot.yml");

    expect(dependabot).toContain("package-ecosystem: github-actions");
    expect(dependabot.match(/package-ecosystem:/gu)).toHaveLength(1);
    expect(dependabot).toContain("target-branch: main");
    expect(dependabot).toContain("interval: weekly");
    expect(dependabot).not.toMatch(/package-ecosystem:\s+(?:npm|pip|uv|docker)/u);
  });

  it("keeps every pinned install-script allowance resolvable to the locked version", () => {
    // `npm ci --strict-allow-scripts` silently skips the install script of any package whose
    // pinned entry has drifted away from the locked version, which would quietly stop building
    // a native dependency. Keep every allowance resolvable to the version actually installed.
    const packageJson = JSON.parse(projectFile("package.json")) as {
      devDependencies?: Record<string, string>;
      allowScripts?: Record<string, boolean>;
    };
    const packageLock = JSON.parse(projectFile("package-lock.json")) as {
      packages: Record<string, { version?: string }>;
    };

    const lockedVersion = (name: string): string => {
      const entries = Object.entries(packageLock.packages).filter(
        ([specifier]) => specifier.endsWith(`node_modules/${name}`),
      );
      expect(
        entries.length,
        `${name} must resolve to exactly one locked install`,
      ).toBe(1);
      return entries[0]?.[1]?.version ?? "";
    };

    const allowScripts = packageJson.allowScripts ?? {};
    expect(Object.keys(allowScripts).length).toBeGreaterThan(0);

    for (const specifier of Object.keys(allowScripts)) {
      const separator = specifier.lastIndexOf("@");
      if (separator <= 0) {
        // Unpinned entries (e.g. a blanket `fsevents: false` denial) carry no version to drift.
        expect(allowScripts[specifier]).toBe(false);
        continue;
      }
      const name = specifier.slice(0, separator);
      const pinnedVersion = specifier.slice(separator + 1);
      expect(
        pinnedVersion,
        `${name} install-script allowance is pinned to a version that is not installed`,
      ).toBe(lockedVersion(name));
    }

  });

  it("resolves the settings-layout Electron binary through the package, not a guessed path", () => {
    // Regression: Electron 43 publishes no install script and downloads its binary lazily on
    // first `require("electron")`. The harness hard-coded `node_modules/electron/dist/...` and
    // spawned it directly, so a fresh `npm ci --strict-allow-scripts` checkout failed this gate
    // with ENOENT before anything could provide the binary.
    const harness = projectFile("scripts/test-settings-scroll-layout.mjs");

    expect(harness).toContain('createRequire(import.meta.url)("electron")');
    expect(harness).not.toContain("node_modules/electron/dist");
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
    expect(forgeConfig).toContain("promoteProtectedResources([");
    expect(forgeConfig).toContain("restoreTrackedProtectedResources();");
    expect(forgeConfig).toContain('process.once("exit", restoreTrackedProtectedResources)');
    expect(forgeConfig.indexOf("promoteProtectedResources([")).toBeLessThan(
      forgeConfig.indexOf("signProtectedMacResources();"),
    );
    expect(forgeConfig).toContain("MAC_STAGED_ACTIVE_TARGET");
    expect(forgeConfig).toContain("MAC_STAGED_FLUID_AUDIO_HELPER");
    expect(forgeConfig).toContain("ignore: isPreSignedProtectedMacResource");
    expect(forgeConfig).toContain("codesign\", [\"--verify\", \"--strict\", binary]");
    expect(forgeConfig).toContain(
      'normalizedPath.endsWith("/native/macos/active-target")',
    );
    expect(forgeConfig).toContain('normalizedPath.includes("/python-runtime/")');
    expect(forgeConfig).toContain("verify-macos-entitlements.mjs");
    /*
     * The main app's entitlements are compared with the release plist as an
     * exact set. A presence check cannot reject an addition, so it let a build
     * carrying `get-task-allow` or `disable-library-validation` ship.
     */
    expect(entitlementVerifier).toContain("assertMainAppEntitlements({");
    expect(entitlementVerifier).toContain("declaredPlist: readFileSync(");
    expect(entitlementVerifier).toContain("assertNoEntitlementKeys(activeTarget)");
    expect(entitlementVerifier).toContain(
      "for (const binary of runtimeMachOFiles) assertNoEntitlementKeys(binary)",
    );
    expect(entitlementVerifier).toContain("for (const binary of nestedMachOFiles)");
    expect(entitlementVerifier).toContain("if (binary !== executable) assertNoEntitlementKeys(binary)");

    expect(forgeConfig).toContain('removeInfoPlistKeyIfPresent(infoPlist, "NSAppTransportSecurity.NSAllowsArbitraryLoads")');
    expect(forgeConfig).toContain('removeInfoPlistKeyIfPresent(infoPlist, "NSBluetoothAlwaysUsageDescription")');
    expect(forgeConfig).toContain('removeInfoPlistKeyIfPresent(infoPlist, "NSCameraUsageDescription")');
  });

  it("enables only Electron's documented accessibility tree and keeps editor resolution fail-closed", () => {
    const helper = projectFile("resources/native/macos/active-target.swift");

    expect(helper).toContain('"AXManualAccessibility" as CFString');
    expect(helper).toContain("AXUIElementSetAttributeValue(");
    expect(helper).toContain("kCFBooleanTrue");
    expect(helper).toContain("focusedElementLookupAttemptCount = 6");
    expect(helper).toContain("focusedElementLookupInterval: TimeInterval = 0.02");
    expect(helper).not.toContain("AXEnhancedUserInterface");

    expect(helper).toContain('"AXEditableAncestor" as CFString');
    expect(helper).not.toContain("AXHighestEditableAncestor");
    expect(helper).toContain("elementIsInParentChain(editableAncestor, of: focusedElement)");
    expect(helper).toContain("elementsShareAccessibilityWindow(editableAncestor, focusedElement)");
    expect(helper).toContain("candidateEditable: focusedElementIsEditable(editableAncestor)");
    expect(helper).toContain("let focusedUIElement = accessibilityTrusted");
    expect(helper).toMatch(
      /focusedUIElementEnablingManualAccessibilityIfNeeded\(focusedApplication\)[\s\S]*?focusedWindowFingerprint\(/u,
    );
    expect(helper).not.toMatch(/knownEditableRoles[\s\S]*?return true/u);

    // Tree activation must not read target content. Value, selected text, and
    // selected range appear only in settable-capability checks, never in an
    // attribute-value read or transcript write.
    expect(helper).not.toContain("kAXTitleAttribute");
    expect(helper.match(/kAXValueAttribute/gu)).toHaveLength(2);
    expect(helper.match(/kAXSelectedTextAttribute/gu)).toHaveLength(2);
    expect(helper.match(/kAXSelectedTextRangeAttribute/gu)).toHaveLength(1);
    expect(helper).toContain("attributeIsSettable(");
    expect(helper).toContain("return textRoleHasMutableValue || selectedTextSettable");
    expect(helper).toContain("kAXComboBoxRole as String");
    expect(helper).toContain("guard let finalTarget = try? captureTarget()");
    expect(helper).toContain("CGEvent offers no compare-and-post transaction");
  });

  it("hardens the Electron fuse configuration without dropping ASAR protections", () => {
    const forgeConfig = projectFile("forge.config.ts");

    expect(forgeConfig).toContain("[FuseV1Options.GrantFileProtocolExtraPrivileges]: false");
    expect(forgeConfig).toContain("[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true");
    expect(forgeConfig).toContain("[FuseV1Options.OnlyLoadAppFromAsar]: true");
  });

  /*
   * The renderer CSP used to be gated with `toContain("script-src 'self'")`
   * plus `not.toContain("script-src 'self' 'unsafe-inline'")` and the same for
   * 'unsafe-eval'. Those negatives reject exactly two adjacent spellings, so
   * any source in between defeats them: an audit verified that
   * `script-src 'self' blob: 'unsafe-inline'`, `script-src 'self'
   * 'wasm-unsafe-eval' 'unsafe-inline'`, and `script-src 'self'
   * https://cdn.example 'unsafe-eval'` all passed. It is the only CSP
   * assertion in the repo, so nothing else would have caught it.
   *
   * Parsing the policy into directives and comparing token *sets* rejects any
   * added source, not a list of spellings someone thought of in advance.
   */
  function rendererContentSecurityPolicy(): Map<string, Set<string>> {
    const document = projectFile("index.html");
    const meta = /<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/iu.exec(document);
    expect(meta, "index.html declares no Content-Security-Policy meta tag").not.toBeNull();
    // Match the attribute's own delimiter: CSP source expressions are
    // single-quoted, so a naive [^"']* stops at the first `'self'`.
    const content = /content=(["'])([\s\S]*?)\1/iu.exec(meta?.[0] ?? "");
    expect(content?.[2], "the CSP meta tag has no content attribute").toBeTruthy();

    const directives = new Map<string, Set<string>>();
    for (const directive of (content?.[2] ?? "").split(";")) {
      const tokens = directive.trim().split(/\s+/u).filter(Boolean);
      const [name, ...sources] = tokens;
      if (!name) continue;
      expect(directives.has(name.toLowerCase()), `${name} is declared twice`).toBe(false);
      directives.set(name.toLowerCase(), new Set(sources));
    }
    return directives;
  }

  it("forbids renderer document embedding, object loading, base rewriting, and form egress", () => {
    const policy = rendererContentSecurityPolicy();

    for (const name of ["base-uri", "object-src", "frame-src", "form-action"]) {
      expect([...(policy.get(name) ?? [])], `${name} must be exactly 'none'`).toEqual(["'none'"]);
    }
  });

  it("allows the renderer to execute nothing but its own bundled scripts", () => {
    const policy = rendererContentSecurityPolicy();
    const scriptSrc = policy.get("script-src");

    expect(scriptSrc, "index.html declares no script-src").toBeDefined();
    // An exact set: no CDN, no blob:, no data:, no 'unsafe-inline',
    // no 'unsafe-eval', no nonce, no hash, however they are ordered.
    expect([...(scriptSrc ?? [])].sort()).toEqual(["'self'"]);
  });

  it("rejects the mutations the previous adjacency check let through", () => {
    // Guarding the guard: these are the exact policies an audit smuggled past
    // the old assertions, run against the parser that replaced them.
    const parse = (policy: string): Set<string> => {
      const directive = policy.split(";").map((part) => part.trim())
        .find((part) => part.startsWith("script-src"));
      return new Set((directive ?? "").split(/\s+/u).slice(1).filter(Boolean));
    };

    for (const escape of [
      "script-src 'self' blob: 'unsafe-inline'",
      "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
      "script-src 'self' https://cdn.example 'unsafe-eval'",
      "script-src 'unsafe-inline' 'self'",
      "script-src 'self' data:",
    ]) {
      expect([...parse(escape)].sort(), `${escape} must not be accepted`).not.toEqual(["'self'"]);
    }
    expect([...parse("script-src 'self'")].sort()).toEqual(["'self'"]);
  });

  it("keeps packaged-main verification in the macOS smoke gate", () => {
    const main = projectFile("src/main.ts");
    const verifier = projectFile("scripts/verify-packaged-main.mjs");
    const macSmoke = projectFile("scripts/smoke-packaged-macos.sh");

    expect(main).not.toContain("electron-squirrel-startup");
    expect(verifier).toContain(
      'path.join(".vite", "build", "main.js")',
    );
    expect(verifier).not.toContain(
      'extractFile(resolvedAsarPath, ".vite/build/main.js")',
    );
    expect(verifier).toContain("Packaged Electron main contains an import.meta.url");
    expect(macSmoke).toContain("verify-packaged-main.mjs");
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
    expect(main).toContain("runtimeReleasePromise ??=");
    expect(main).toContain('if (quitting) throw new Error("LocalScribe is shutting down")');
  });

  /*
   * `abort()` only kills the process that is running now. A model operation
   * already queued behind it would start a replacement, so Quit during a repair
   * spawned a fresh Python child and loaded a multi-gigabyte model that nothing
   * would ever use. `retire()` latches the supervisor closed, and it only works
   * if it lands first — the supervisor's own behaviour is covered in
   * tests/workerSupervisor.test.ts, but nothing asserted that main calls it.
   */
  it("latches the worker supervisor closed before aborting it on quit", () => {
    const main = projectFile("src/main.ts");
    const shutdown = main.slice(main.indexOf("function beginShutdown"));
    const body = shutdown.slice(0, shutdown.indexOf("function finishShutdown"));

    const retire = body.indexOf('worker.retire();');
    const abort = body.indexOf('worker.abort("LocalScribe is quitting")');
    expect(retire).toBeGreaterThan(-1);
    expect(abort).toBeGreaterThan(-1);
    expect(retire).toBeLessThan(abort);
  });

  /*
   * Quit closes the database while the worker shutdown and audio-cache removal
   * are still running. The macOS menu bar stayed live for that whole window and
   * several of its items read the database ("Copy Last Transcript", the My
   * Voice counts), so a click after `database.close()` threw inside main.
   */
  it("retires the macOS application menu with the same shutdown latch", () => {
    const main = projectFile("src/main.ts");
    const shutdown = main.slice(main.indexOf("function beginShutdown"));
    const body = shutdown.slice(0, shutdown.indexOf("function finishShutdown"));

    expect(body).toContain("Menu.setApplicationMenu(null);");

    // The menu really is database-backed, which is why this matters.
    const menu = main.slice(
      main.indexOf("function installApplicationMenu(): void"),
      main.indexOf("Menu.setApplicationMenu(Menu.buildFromTemplate(template));"),
    );
    // Still database-backed after the reads were narrowed to counts: the menu
    // no longer decrypts anything, but it does still query, which is what makes
    // retiring it before the database closes necessary.
    expect(menu).toContain("database.hasTranscriptions()");
    expect(menu).toContain("database.countDictionary()");
    expect(menu).toContain("database.getSettings()");
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
    expect(forgeConfig).toContain('execFileSync("codesign", ["--verify"');
    expect(forgeConfig).toContain('execFileSync("spctl", ["--assess"');
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

  it("builds the macOS worker runtime from its committed uv lock", () => {
    const macBuild = projectFile("scripts/build-worker-runtime.sh");

    expect(macBuild).toContain("3.12.13");
    expect(macBuild).toContain("--locked");
    expect(macBuild).toContain("--no-editable");
    expect(macBuild).not.toContain("uv pip install");
    expect(macBuild).toContain('"$uv_bin" sync');
    expect(macBuild).toContain('"$uv_bin" lock --check');
    expect(macBuild).toContain('"$project_root/.uv-version"');
    expect(macBuild).toContain("--reinstall-package localscribe-worker");
    expect(macBuild).toContain('python_build_tag="20260504"');
    expect(macBuild).toContain("--python-downloads-json-url");
    expect(macBuild).toContain("scripts/python-build-standalone.json");
    expect(macBuild).toContain("out/runtime-staging/native/macos/localscribe-fluidaudio-parakeet");
    expect(macBuild).not.toContain(
      'fluid_audio_helper_output="$project_root/resources/native/macos/localscribe-fluidaudio-parakeet"',
    );
  });

  it("always removes the renderer permission probe's private temporary directory", () => {
    const probe = projectFile("scripts/measure-renderer-permission-names.mjs");

    expect(probe).toContain("const probeRoot = mkdtempSync(");
    expect(probe).toContain("} finally {");
    expect(probe).toContain("rmSync(probeRoot, { force: true, recursive: true })");
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
    expect(localMacVerification).toContain('asset_name="$(basename "$artifact")"');
    expect(localMacVerification).toContain(
      "verify-release-assets.mjs --platform darwin --candidate",
    );
    expect(localMacVerification).toContain(
      "verify-release-assets.mjs --platform darwin",
    );
    expect(localMacVerification).toContain("codesign --verify --deep --strict");
    expect(localMacVerification).toContain("verify-macos-entitlements.mjs");
    expect(localMacVerification).not.toMatch(/npm run sbom/u);
  });

  /*
   * `scripts/` was outside the typecheck, and everything that decides whether a
   * build ships lives there: the entitlement policy, the provenance check, the
   * settings-layout gate's renderer harness. Adding a required field to a
   * contract compiled clean and then crashed the layout gate at runtime with
   * "Cannot read properties of undefined", which is the failure mode a
   * typechecker exists to prevent. Shrinking this list again silently removes
   * that coverage, so it is pinned.
   */
  it("typechecks the scripts that gate a release", () => {
    const tsconfig = JSON.parse(projectFile("tsconfig.json")) as { include?: string[] };
    const included = tsconfig.include ?? [];

    expect(included).toContain("src");
    expect(included).toContain("tests");
    for (const pattern of ["scripts/**/*.ts", "scripts/**/*.mts", "scripts/**/*.tsx"]) {
      expect(included, `tsconfig no longer typechecks ${pattern}`).toContain(pattern);
    }
    // The gate command has to be the one that reads this config.
    const packageJson = JSON.parse(projectFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.typecheck).toBe("tsc --noEmit");
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
