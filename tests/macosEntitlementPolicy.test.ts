import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_ENTITLEMENTS,
  REQUIRED_ENTITLEMENTS,
  UNIVERSALLY_FORBIDDEN_ENTITLEMENTS,
  assertHelperEntitlements,
  assertMainAppEntitlements,
  assertUnprivileged,
  entitlementKeys,
  helperEntitlementRole,
} from "../scripts/macos-entitlement-policy.mts";
import { expectPrecedes, sliceBetween } from "./support/order";

const projectRoot = path.resolve(__dirname, "..");

function plist(keys: readonly string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    "<dict>",
    ...keys.map((key) => `\t<key>${key}</key>\n\t<true/>`),
    "</dict>",
    "</plist>",
  ].join("\n");
}

function fail(message: string): never {
  throw new Error(message);
}

const declaredPlist = readFileSync(
  path.join(projectRoot, "resources/entitlements.mac.plist"),
  "utf8",
);

describe("macOS main-app entitlement policy", () => {
  it("accepts a signature that carries exactly the declared entitlements", () => {
    expect(
      assertMainAppEntitlements({
        declaredPlist,
        signedPlist: plist(entitlementKeys(declaredPlist)),
        fail,
      }),
    ).toEqual(REQUIRED_ENTITLEMENTS);
  });

  it("accepts the shipped release plist as its own signature", () => {
    expect(
      assertMainAppEntitlements({ declaredPlist, signedPlist: declaredPlist, fail }),
    ).toEqual([...REQUIRED_ENTITLEMENTS]);
  });

  /*
   * The defect this file exists for: the gate asserted only that the two
   * required keys were present, so every one of these builds shipped.
   */
  it.each([...FORBIDDEN_ENTITLEMENTS])(
    "rejects a signature that adds %s alongside the required capabilities",
    (escape) => {
      expect(() =>
        assertMainAppEntitlements({
          declaredPlist,
          signedPlist: plist([...REQUIRED_ENTITLEMENTS, escape]),
          fail,
        }),
      ).toThrow(new RegExp(`hardened-runtime escapes: ${escape.replace(/[.]/gu, "\\.")}`, "u"));
    },
  );

  it("rejects an undeclared entitlement even when it is not a known escape", () => {
    expect(() =>
      assertMainAppEntitlements({
        declaredPlist,
        signedPlist: plist([...REQUIRED_ENTITLEMENTS, "com.apple.security.device.camera"]),
        fail,
      }),
    ).toThrow(/does not declare: com\.apple\.security\.device\.camera$/u);
  });

  it("rejects a signature that dropped a declared entitlement", () => {
    expect(() =>
      assertMainAppEntitlements({
        declaredPlist,
        signedPlist: plist(["com.apple.security.cs.allow-jit"]),
        fail,
      }),
    ).toThrow(/is missing com\.apple\.security\.device\.audio-input/u);
  });

  it("rejects a release plist that stopped declaring a required capability", () => {
    expect(() =>
      assertMainAppEntitlements({
        declaredPlist: plist(["com.apple.security.cs.allow-jit"]),
        signedPlist: plist(["com.apple.security.cs.allow-jit"]),
        fail,
      }),
    ).toThrow(/no longer grants com\.apple\.security\.device\.audio-input/u);
  });

  /*
   * Widening the allowlist must not be a way to pass the gate: an escape in the
   * plist is rejected even though the signature then matches it exactly.
   */
  it("rejects a release plist that declares a hardened-runtime escape", () => {
    const widened = plist([...REQUIRED_ENTITLEMENTS, "com.apple.security.get-task-allow"]);
    expect(() =>
      assertMainAppEntitlements({ declaredPlist: widened, signedPlist: widened, fail }),
    ).toThrow(/declares hardened-runtime escapes: com\.apple\.security\.get-task-allow/u);
  });

  /*
   * The second defect, and the reason this file now parses instead of
   * pattern-matching. The verifier called itself an exact comparison but
   * extracted only <key> elements, so the VALUES were never looked at. A
   * signature granting neither capability — both required entitlements set to
   * `false` — was accepted as correct. Reproduced verbatim below.
   */
  describe("entitlement values, not just keys", () => {
    function valuedPlist(entries: ReadonlyArray<readonly [string, string]>): string {
      return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<plist version="1.0">',
        "<dict>",
        ...entries.map(([key, value]) => `\t<key>${key}</key>\n\t${value}`),
        "</dict>",
        "</plist>",
      ].join("\n");
    }

    it("rejects the reported reproduction: required entitlements signed false", () => {
      expect(() =>
        assertMainAppEntitlements({
          declaredPlist,
          signedPlist: valuedPlist(REQUIRED_ENTITLEMENTS.map((key) => [key, "<false/>"])),
          fail,
        }),
      ).toThrow(/values differ from the release plist/u);
    });

    it.each([...REQUIRED_ENTITLEMENTS])("rejects %s signed false on its own", (required) => {
      expect(() =>
        assertMainAppEntitlements({
          declaredPlist,
          signedPlist: valuedPlist(
            REQUIRED_ENTITLEMENTS.map((key) => [key, key === required ? "<false/>" : "<true/>"]),
          ),
          fail,
        }),
      ).toThrow(new RegExp(`${required.replace(/[.]/gu, "\\.")} \\(declared true, signed false\\)`, "u"));
    });

    it("rejects a scalar value that changed type or content", () => {
      const declared = valuedPlist([
        ["com.apple.security.cs.allow-jit", "<true/>"],
        ["com.apple.security.device.audio-input", "<true/>"],
        ["com.apple.security.application-groups", "<string>group.localscribe</string>"],
      ]);
      const signed = valuedPlist([
        ["com.apple.security.cs.allow-jit", "<true/>"],
        ["com.apple.security.device.audio-input", "<true/>"],
        ["com.apple.security.application-groups", "<string>group.other</string>"],
      ]);
      expect(() => assertMainAppEntitlements({ declaredPlist: declared, signedPlist: signed, fail }))
        .toThrow(/application-groups \(declared string\("group\.localscribe"\)/u);
    });

    it("rejects an array value that gained a member", () => {
      const declared = valuedPlist([
        ["com.apple.security.cs.allow-jit", "<true/>"],
        ["com.apple.security.device.audio-input", "<true/>"],
        ["com.apple.security.temporary-exception.files.absolute-path.read-only",
          "<array><string>/opt/a</string></array>"],
      ]);
      const signed = valuedPlist([
        ["com.apple.security.cs.allow-jit", "<true/>"],
        ["com.apple.security.device.audio-input", "<true/>"],
        ["com.apple.security.temporary-exception.files.absolute-path.read-only",
          "<array><string>/opt/a</string><string>/opt/b</string></array>"],
      ]);
      expect(() => assertMainAppEntitlements({ declaredPlist: declared, signedPlist: signed, fail }))
        .toThrow(/values differ from the release plist/u);
    });

    it("rejects a nested dict value that gained a key", () => {
      const declared = valuedPlist([
        ["com.apple.security.cs.allow-jit", "<true/>"],
        ["com.apple.security.device.audio-input", "<true/>"],
        ["com.apple.developer.endpoint", "<dict><key>a</key><true/></dict>"],
      ]);
      const signed = valuedPlist([
        ["com.apple.security.cs.allow-jit", "<true/>"],
        ["com.apple.security.device.audio-input", "<true/>"],
        ["com.apple.developer.endpoint", "<dict><key>a</key><true/><key>b</key><true/></dict>"],
      ]);
      expect(() => assertMainAppEntitlements({ declaredPlist: declared, signedPlist: signed, fail }))
        .toThrow(/values differ from the release plist/u);
    });

    it("rejects a duplicate key rather than choosing one of the two values", () => {
      const duplicated = valuedPlist([
        ["com.apple.security.cs.allow-jit", "<true/>"],
        ["com.apple.security.device.audio-input", "<true/>"],
        ["com.apple.security.cs.allow-jit", "<false/>"],
      ]);
      expect(() =>
        assertMainAppEntitlements({ declaredPlist, signedPlist: duplicated, fail }),
      ).toThrow(/declared more than once/u);
    });

    it("rejects a malformed plist instead of reading zero entitlements from it", () => {
      for (const malformed of [
        "not a plist at all",
        "<plist><dict><key>a</key></dict></plist>",
        '<plist version="1.0"><dict><key>a</key><true/>',
        "<plist><array><true/></array></plist>",
        "<plist><dict><key>a</key><bogus/></dict></plist>",
      ]) {
        expect(() =>
          assertMainAppEntitlements({ declaredPlist, signedPlist: malformed, fail }),
        ).toThrow(/could not be parsed|is not a dictionary/u);
      }
    });

    it("finds a forbidden entitlement even when it is signed false", () => {
      expect(() =>
        assertMainAppEntitlements({
          declaredPlist,
          signedPlist: valuedPlist([
            ...REQUIRED_ENTITLEMENTS.map((key) => [key, "<true/>"] as const),
            ["com.apple.security.get-task-allow", "<false/>"],
          ]),
          fail,
        }),
      ).toThrow(/hardened-runtime escapes: com\.apple\.security\.get-task-allow/u);
    });

    it("does not treat a nested key as a top-level entitlement", () => {
      // The regex reader could not tell these apart; the parser can.
      const nested = valuedPlist([
        ["com.apple.security.cs.allow-jit", "<true/>"],
        ["com.apple.security.device.audio-input", "<true/>"],
        ["com.apple.developer.endpoint",
          "<dict><key>com.apple.security.get-task-allow</key><true/></dict>"],
      ]);
      // It is still rejected — as an undeclared top-level key — but for the
      // right reason, and `entitlementKeys` must not list the nested one.
      expect(entitlementKeys(nested)).not.toContain("com.apple.security.get-task-allow");
      expect(() => assertMainAppEntitlements({ declaredPlist, signedPlist: nested, fail }))
        .toThrow(/does not declare: com\.apple\.developer\.endpoint/u);
    });
  });

  it("reads the keys codesign prints and ignores the values", () => {
    expect(
      entitlementKeys(
        '<?xml version="1.0"?><plist version="1.0"><dict>' +
          "<key>com.apple.security.cs.allow-jit</key><true/>" +
          "<key>com.apple.security.device.audio-input</key><true/>" +
          "</dict></plist>",
      ),
    ).toEqual([...REQUIRED_ENTITLEMENTS]);
    expect(entitlementKeys("<plist><dict/></plist>")).toEqual([]);
  });

  it("keeps the shipped plist inside the policy it enforces", () => {
    const declared = entitlementKeys(declaredPlist);
    expect(declared).toEqual([...REQUIRED_ENTITLEMENTS]);
    for (const key of declared) expect(FORBIDDEN_ENTITLEMENTS.has(key)).toBe(false);
  });

  it("keeps the verifier CLI on this policy instead of a presence check", () => {
    const verifier = readFileSync(
      path.join(projectRoot, "scripts/verify-macos-entitlements.mjs"),
      "utf8",
    );
    expect(verifier).toContain("assertMainAppEntitlements({");
    expect(verifier).toContain('from "./macos-entitlement-policy.mts"');
  });
});

/*
 * The four Electron helper apps under Contents/Frameworks were verified by
 * nothing.
 *
 * The packaged gate inspected the outer bundle, native/macos/active-target, and
 * the Python runtime, and never walked Contents/Frameworks. verify-macos-bundle
 * checks the outer app only. package-provenance hashes the helper plists, so it
 * records a change rather than rejecting one. And the single unit assertion on
 * their content screened for the strings "camera", "bluetooth", "usb", "print",
 * "location", and "NSAllowsArbitraryLoads" — not one of which is a
 * hardened-runtime escape. Adding `get-task-allow` to the renderer helper, the
 * process holding decrypted transcripts, passed every gate.
 */
describe("macOS helper entitlement policy", () => {
  const helperPlist = readFileSync(
    path.join(projectRoot, "resources/entitlements.mac.helper.plist"),
    "utf8",
  );
  const pluginPlist = readFileSync(
    path.join(projectRoot, "resources/entitlements.mac.plugin.plist"),
    "utf8",
  );

  function assertHelper(signedPlist: string, role: "helper" | "plugin" = "helper"): string[] {
    return assertHelperEntitlements({
      role,
      label: role === "plugin" ? "LocalScribe Helper (Plugin).app" : "LocalScribe Helper (Renderer).app",
      declaredPlist: role === "plugin" ? pluginPlist : helperPlist,
      signedPlist,
      fail,
    });
  }

  it("routes each helper bundle to the plist forge.config.ts signs it with", () => {
    // "(Plugin)" also contains "LocalScribe Helper", so ordering matters and is
    // the kind of thing that silently inverts.
    expect(helperEntitlementRole("Frameworks/LocalScribe Helper (Plugin).app")).toBe("plugin");
    expect(helperEntitlementRole("Frameworks/LocalScribe Helper (Renderer).app")).toBe("helper");
    expect(helperEntitlementRole("Frameworks/LocalScribe Helper (GPU).app")).toBe("helper");
    expect(helperEntitlementRole("Frameworks/LocalScribe Helper.app")).toBe("helper");
    expect(helperEntitlementRole("Frameworks/Electron Framework.framework")).toBeNull();
    expect(helperEntitlementRole("LocalScribe.app")).toBeNull();
  });

  it("accepts each shipped helper plist as its own signature", () => {
    expect(assertHelper(helperPlist)).toEqual(["com.apple.security.cs.allow-jit"]);
    expect(assertHelper(pluginPlist, "plugin")).toEqual([
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.cs.disable-library-validation",
    ]);
  });

  /*
   * THE REPORTED HOLE, at the exact entitlement named. Any process the user
   * runs could `task_for_pid` the renderer helper and read decrypted transcript
   * text, scratchpad bodies, and clipboard content out of its memory.
   */
  it("rejects a renderer helper signed get-task-allow", () => {
    expect(() =>
      assertHelper(plist(["com.apple.security.cs.allow-jit", "com.apple.security.get-task-allow"])),
    ).toThrow(/hardened-runtime escapes: com\.apple\.security\.get-task-allow/u);
  });

  it.each([...FORBIDDEN_ENTITLEMENTS])(
    "rejects a renderer helper that adds %s",
    (escape) => {
      expect(() => assertHelper(plist(["com.apple.security.cs.allow-jit", escape])))
        .toThrow(new RegExp(escape.replaceAll(".", "\\."), "u"));
    },
  );

  it.each([...UNIVERSALLY_FORBIDDEN_ENTITLEMENTS])(
    "rejects even the plugin helper when it adds %s",
    (escape) => {
      expect(() =>
        assertHelper(
          plist([
            "com.apple.security.cs.allow-unsigned-executable-memory",
            "com.apple.security.cs.disable-library-validation",
            escape,
          ]),
          "plugin",
        ),
      ).toThrow(new RegExp(escape.replaceAll(".", "\\."), "u"));
    },
  );

  it("rejects the escapes the plugin helper needs when they appear on a renderer helper", () => {
    // Legitimate for the plugin host, never for the process holding transcripts.
    for (const escape of [
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.cs.disable-library-validation",
    ]) {
      expect(() => assertHelper(plist(["com.apple.security.cs.allow-jit", escape])))
        .toThrow(new RegExp(escape.replaceAll(".", "\\."), "u"));
      // ...and the same key is accepted in the plugin role, so the two policies
      // are genuinely different rather than one of them being unreachable.
      expect(assertHelper(pluginPlist, "plugin")).toContain(escape);
    }
  });

  it("rejects a helper whose declared capability was signed false", () => {
    // The value, not just the key: `<key>allow-jit</key><false/>` has the key
    // and not the capability, and vice versa is how one is silently gained.
    const signedFalse = helperPlist.replace("<true/>", "<false/>");
    expect(() => assertHelper(signedFalse)).toThrow(/values differ/u);
  });

  it("rejects a helper carrying an entitlement its plist does not declare", () => {
    expect(() =>
      assertHelper(plist([
        "com.apple.security.cs.allow-jit",
        "com.apple.security.device.audio-input",
      ])),
    ).toThrow(/does not declare: com\.apple\.security\.device\.audio-input/u);
  });

  it("rejects a helper missing an entitlement its plist declares", () => {
    expect(() => assertHelper(plist([]))).toThrow(/is missing com\.apple\.security\.cs\.allow-jit/u);
  });

  it("rejects an unsigned or entitlement-free helper rather than reading it as fine", () => {
    expect(() => assertHelper("")).toThrow(/is missing/u);
    expect(() => assertHelper("   \n ")).toThrow(/is missing/u);
  });

  it("rejects a malformed signature instead of interpreting it generously", () => {
    expect(() => assertHelper("<plist><dict><key>a</key></dict></plist>"))
      .toThrow(/could not be parsed/u);
    expect(() => assertHelper("not a plist at all")).toThrow(/could not be parsed/u);
  });

  it("rejects a duplicate key, which two readers can disagree about", () => {
    expect(() =>
      assertHelper([
        '<plist version="1.0">',
        "<dict>",
        "<key>com.apple.security.cs.allow-jit</key><true/>",
        "<key>com.apple.security.cs.allow-jit</key><false/>",
        "</dict>",
        "</plist>",
      ].join("\n")),
    ).toThrow(/declared more than once/u);
  });

  /*
   * The gate for everything that is supposed to carry nothing: active-target,
   * every Mach-O in the Python runtime, and every framework binary. It asked
   * whether the blob contained the substring "<key>", which is not how a plist
   * parser reads a plist — `plutil` reports `<key >…</key>` as granted, and
   * the same run of this suite proves the parser does too.
   */
  describe("binaries that must carry no entitlements", () => {
    const assertNone = (signedPlist: string) =>
      assertUnprivileged({ label: "python-runtime/bin/python3", signedPlist, fail });

    it("accepts a binary signed with no entitlements blob at all", () => {
      // What `codesign -d --entitlements :-` prints for such a binary: nothing.
      expect(assertNone("")).toEqual([]);
      expect(assertNone("  \n ")).toEqual([]);
    });

    it("accepts an empty dictionary, the other spelling of the same thing", () => {
      expect(assertNone(
        '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict></dict></plist>',
      )).toEqual([]);
    });

    it("rejects a whitespace-padded key tag that the substring gate read as clean", () => {
      const spaced = '<plist version="1.0"><dict>'
        + "<key >com.apple.security.get-task-allow</key><true/>"
        + "</dict></plist>";
      // The exact shape the old gate missed: plutil grants it, includes() does not see it.
      expect(spaced.includes("<key>")).toBe(false);
      expect(() => assertNone(spaced))
        .toThrow(/carries privileged entitlements: com\.apple\.security\.get-task-allow/u);
    });

    it("rejects an ordinary entitlement too, not only the padded spelling", () => {
      expect(() => assertNone(plist(["com.apple.security.device.audio-input"])))
        .toThrow(/carries privileged entitlements: com\.apple\.security\.device\.audio-input/u);
    });

    it("rejects an entitlement set to false, which is still an entitlement", () => {
      const disabled = '<plist version="1.0"><dict>'
        + "<key>com.apple.security.get-task-allow</key><false/>"
        + "</dict></plist>";
      expect(() => assertNone(disabled)).toThrow(/carries privileged entitlements/u);
    });

    it("rejects an unreadable blob rather than treating it as carrying nothing", () => {
      expect(() => assertNone("not a plist at all")).toThrow(/could not be read/u);
      expect(() => assertNone("<plist><dict><key>a</key></dict></plist>"))
        .toThrow(/could not be read/u);
    });

    it("names the binary it rejected, so the failure is actionable", () => {
      expect(() => assertNone(plist(["com.apple.security.cs.allow-jit"])))
        .toThrow(/python-runtime\/bin\/python3/u);
    });

    it("is what the packaged gate calls, not a second rule of its own", () => {
      /*
       * The behaviour above is only worth something if the gate that runs
       * against a real bundle routes through it. It previously carried its own
       * `plist.includes("<key>")` test, which is the defect.
       */
      const verifier = readFileSync(
        path.join(projectRoot, "scripts/verify-macos-entitlements.mjs"),
        "utf8",
      );

      expect(verifier).toContain("assertUnprivileged({");
      expect(verifier).not.toContain('includes("<key>")');
    });
  });

  it("keeps the packaged gate walking Contents/Frameworks", () => {
    const verifier = readFileSync(
      path.join(projectRoot, "scripts/verify-macos-entitlements.mjs"),
      "utf8",
    );
    // Structural, and narrow on purpose: the behaviour above is covered by
    // execution, but nothing else proves the gate reaches the helpers at all.
    expect(verifier).toContain('path.join(appPath, "Contents", "Frameworks")');
    expect(verifier).toContain("assertHelperEntitlements({");
    expect(verifier).toContain("helperEntitlementRole(bundle)");
  });

  it("gives the crash reporter no entitlements instead of the main app's", () => {
    // It fell through to the main plist, so a crash handler shipped holding the
    // microphone entitlement. Caught by the Frameworks walk added above.
    const forge = readFileSync(path.join(projectRoot, "forge.config.ts"), "utf8");
    const routing = sliceBetween(
      forge,
      "function signingEntitlementsFor",
      "return MAC_ENTITLEMENTS;",
      "forge.config.ts",
    );
    expectPrecedes(routing, "chrome_crashpad_handler", "MAC_PLUGIN_ENTITLEMENTS");
    expect(routing).toMatch(/chrome_crashpad_handler[\s\S]{0,80}MAC_RUNTIME_ENTITLEMENTS/u);
  });

  it("gives Squirrel's updater no entitlements instead of the main app's", () => {
    /*
     * Same fall-through as the crash reporter, found the same way — by the
     * Frameworks walk, on the first packaged build after it was added. ShipIt
     * replaces the application bundle on disk; it shipped with the microphone
     * entitlement and permission to map writable-executable memory.
     */
    const forge = readFileSync(path.join(projectRoot, "forge.config.ts"), "utf8");
    const routing = sliceBetween(
      forge,
      "function signingEntitlementsFor",
      "return MAC_ENTITLEMENTS;",
      "forge.config.ts",
    );
    // Ahead of the helper branches, or `LocalScribe Helper` would never see it
    // — and ahead of the main-app fall-through, which is the bug.
    expectPrecedes(routing, "ShipIt", "MAC_PLUGIN_ENTITLEMENTS");
    expect(routing).toMatch(/ShipIt[\s\S]{0,80}MAC_RUNTIME_ENTITLEMENTS/u);
    /*
     * Anchored on the framework, not on a versioned path. @electron/osx-sign
     * walks with `stat` where it means `lstat`, so `Versions/Current` and
     * `Resources` are treated as real directories and this one binary is
     * signed under three spellings. A branch pinned to `Versions/A/...`
     * matched one of them, and the last signature — taken through a symlinked
     * path — put the main app's entitlements back. The build failed twice
     * before this was the check.
     */
    expect(routing).toContain(
      'if (normalizedPath.includes("/Squirrel.framework/") && normalizedPath.endsWith("/ShipIt"))',
    );
  });

  it("declares the unprivileged plist as genuinely empty", () => {
    // Both fall-through fixes route to this file, so an entitlement added here
    // would silently re-privilege the crash reporter and the updater at once.
    const runtime = readFileSync(
      path.join(projectRoot, "resources/entitlements.mac.runtime.plist"),
      "utf8",
    );
    expect(entitlementKeys(runtime)).toEqual([]);
    expect(runtime).toContain("<dict/>");
  });
});
