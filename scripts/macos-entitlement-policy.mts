/**
 * What the signed macOS app is allowed to ask the kernel for.
 *
 * This check has been wrong twice, in opposite directions, and both times it
 * still reported success:
 *
 *  1. Originally it asserted only that the two capabilities LocalScribe needs
 *     were *present*. A presence check cannot reject an addition, so a build
 *     that also carried `get-task-allow` (any process the user runs can attach
 *     and read decrypted transcripts out of memory) passed unchanged.
 *
 *  2. The fix compared the two plists as an exact set of *keys*, extracted with
 *     a regex over `<key>` elements. Entitlements are key/value pairs and the
 *     value is the whole point: a signature carrying
 *     `<key>com.apple.security.device.audio-input</key><false/>` has the key and
 *     not the capability. Both required entitlements could be signed `false`
 *     and the gate still passed — verified by reproduction. A regex over
 *     `<key>` is also blind to nesting, so a key buried inside an array or a
 *     nested dict was indistinguishable from a top-level entitlement.
 *
 * The comparison is therefore structural: both documents are parsed into
 * values, and the top-level dictionaries are compared as canonical key/value
 * maps. A changed scalar, a broadened array or dict, a duplicate key, or a
 * document that does not parse are all rejections.
 */

export const FORBIDDEN_ENTITLEMENTS: ReadonlySet<string> = new Set([
  "com.apple.security.get-task-allow",
  "com.apple.security.cs.disable-library-validation",
  "com.apple.security.cs.disable-executable-page-protection",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.allow-dyld-environment-variables",
  "com.apple.security.cs.debugger",
]);

/** The capabilities LocalScribe cannot run without. Each must be exactly true. */
export const REQUIRED_ENTITLEMENTS: readonly string[] = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.device.audio-input",
];

/**
 * Entitlements that may not appear on *any* LocalScribe signature, in any role.
 *
 * `FORBIDDEN_ENTITLEMENTS` above is the main app's list and it is stricter:
 * Electron's plugin helper legitimately declares two of those six, so applying
 * that list wholesale to every nested bundle would reject a correct build. This
 * is the subset that is never legitimate anywhere — `get-task-allow` and
 * `cs.debugger` make the process attachable, `disable-executable-page-
 * protection` and `allow-dyld-environment-variables` let another process
 * substitute code into it. Any of them on the renderer helper means decrypted
 * transcript text can be read out of memory by anything the user runs.
 */
export const UNIVERSALLY_FORBIDDEN_ENTITLEMENTS: ReadonlySet<string> = new Set([
  "com.apple.security.get-task-allow",
  "com.apple.security.cs.debugger",
  "com.apple.security.cs.disable-executable-page-protection",
  "com.apple.security.cs.allow-dyld-environment-variables",
]);

/**
 * How each nested helper bundle is signed, and how strictly it is policed.
 *
 * These bundles were verified by nothing at all. The packaged gate inspected
 * the outer app, `native/macos/active-target`, and the Python runtime, and
 * never walked `Contents/Frameworks` — which is where all four helper apps
 * live. The only other check on their plists screened for the strings
 * "camera", "bluetooth", "usb", "print", "location", and
 * "NSAllowsArbitraryLoads", none of which is a hardened-runtime escape. So
 * adding `get-task-allow` to the renderer helper — the process that holds
 * decrypted transcripts — passed the unit suite and printed
 * "macOS entitlements verified".
 *
 * The routing mirrors `signingEntitlementsFor` in forge.config.ts, most
 * specific first, and `helperEntitlementRole` is tested against the real
 * bundle names.
 */
export const HELPER_ENTITLEMENT_ROLES = {
  plugin: {
    declaredPlistPath: "resources/entitlements.mac.plugin.plist",
    /*
     * Electron's plugin helper hosts third-party plugin code and cannot run
     * without unsigned executable memory and library validation disabled. Those
     * two are therefore permitted here and *only* here — and only because the
     * exact-set comparison below still pins them to the declared plist, so the
     * exemption cannot widen without editing that file.
     */
    forbidden: UNIVERSALLY_FORBIDDEN_ENTITLEMENTS,
  },
  helper: {
    declaredPlistPath: "resources/entitlements.mac.helper.plist",
    // Renderer, GPU, and utility. The renderer holds decrypted transcript text,
    // scratchpad bodies, and clipboard content, so it gets the main app's full
    // hardened-runtime list.
    forbidden: FORBIDDEN_ENTITLEMENTS,
  },
} as const;

export type HelperEntitlementRole = keyof typeof HELPER_ENTITLEMENT_ROLES;

/** Which plist a nested bundle is signed with, or null if it is not a helper. */
export function helperEntitlementRole(bundlePath: string): HelperEntitlementRole | null {
  const normalized = bundlePath.replaceAll("\\", "/");
  // Most specific first, exactly as forge.config.ts routes it: "(Plugin)" also
  // contains "LocalScribe Helper".
  if (normalized.includes("LocalScribe Helper (Plugin).app")) return "plugin";
  if (normalized.includes("LocalScribe Helper")) return "helper";
  return null;
}

/**
 * Compare a nested helper's signed entitlements with the plist that declared
 * them, and reject the escapes its role may never carry.
 *
 * Separate from `assertMainAppEntitlements` because a helper has no required
 * capabilities of its own — the question is only whether it carries exactly
 * what was declared and nothing dangerous.
 */
export function assertHelperEntitlements({
  role,
  label,
  declaredPlist,
  signedPlist,
  fail,
}: {
  role: HelperEntitlementRole;
  label: string;
  declaredPlist: string;
  signedPlist: string;
  fail: (message: string) => never;
}): string[] {
  const parse = (source: string, what: string): Map<string, PlistValue> => {
    try {
      return parseEntitlements(source);
    } catch (error) {
      return fail(`${what} could not be parsed: ${(error as Error).message}`);
    }
  };
  const policy = HELPER_ENTITLEMENT_ROLES[role];
  const declared = parse(declaredPlist, policy.declaredPlistPath);
  // An unsigned or entitlement-free helper produces empty output rather than a
  // plist. Treat that as "no entitlements", which the comparison then rejects
  // against a non-empty declaration.
  const signed = signedPlist.trim().length === 0
    ? new Map<string, PlistValue>()
    : parse(signedPlist, `${label}'s signed entitlements`);

  for (const source of [
    { keys: [...declared.keys()], what: policy.declaredPlistPath },
    { keys: [...signed.keys()], what: label },
  ]) {
    const escapes = source.keys.filter((key) => policy.forbidden.has(key));
    if (escapes.length > 0) {
      fail(`${source.what} carries hardened-runtime escapes: ${escapes.join(", ")}`);
    }
  }

  const missing = [...declared.keys()].filter((key) => !signed.has(key));
  if (missing.length > 0) fail(`${label} is missing ${missing.join(", ")}`);

  const unexpected = [...signed.keys()].filter((key) => !declared.has(key));
  if (unexpected.length > 0) {
    fail(
      `${label} carries entitlements ${policy.declaredPlistPath} does not declare: ${unexpected.join(", ")}`,
    );
  }

  // Values, not just keys: `<key>allow-jit</key><false/>` has the key and not
  // the capability, and the reverse direction is how a helper silently gains one.
  const divergent: string[] = [];
  for (const [key, declaredValue] of declared) {
    const signedValue = signed.get(key);
    if (signedValue === undefined) continue;
    if (canonicalize(declaredValue) !== canonicalize(signedValue)) {
      divergent.push(
        `${key} (declared ${canonicalize(declaredValue)}, signed ${canonicalize(signedValue)})`,
      );
    }
  }
  if (divergent.length > 0) {
    fail(
      `${label}'s entitlement values differ from ${policy.declaredPlistPath}: ${divergent.join("; ")}`,
    );
  }

  return [...signed.keys()];
}

export type PlistValue =
  | { kind: "bool"; value: boolean }
  | { kind: "string"; value: string }
  | { kind: "integer"; value: string }
  | { kind: "real"; value: string }
  | { kind: "data"; value: string }
  | { kind: "date"; value: string }
  | { kind: "array"; value: PlistValue[] }
  | { kind: "dict"; value: Map<string, PlistValue> };

interface Token {
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly text: string;
}

/**
 * Minimal XML-plist reader.
 *
 * Deliberately not a general XML parser: it accepts exactly the element set the
 * plist format uses and throws on anything else. "Something unexpected in the
 * entitlements" is a rejection, not something to interpret generously — this
 * runs on the artifact that decides what a signed binary may do.
 */
class PlistReader {
  private index = 0;

  private readonly tokens: Token[];

  constructor(source: string) {
    const withoutProlog = source
      .replace(/<\?xml[\s\S]*?\?>/gu, "")
      .replace(/<!DOCTYPE[\s\S]*?>/gu, "")
      .replace(/<!--[\s\S]*?-->/gu, "");
    this.tokens = PlistReader.tokenize(withoutProlog);
  }

  private static tokenize(source: string): Token[] {
    const tokens: Token[] = [];
    const pattern = /<\s*(\/?)\s*([A-Za-z0-9_-]+)[^>]*?(\/?)\s*>/gu;
    let cursor = 0;
    for (;;) {
      const match = pattern.exec(source);
      if (!match) break;
      tokens.push({
        name: (match[2] ?? "").toLowerCase(),
        closing: match[1] === "/",
        selfClosing: match[3] === "/",
        text: source.slice(cursor, match.index),
      });
      cursor = match.index + match[0].length;
    }
    if (source.slice(cursor).trim().length > 0) {
      throw new Error("trailing text after the final plist element");
    }
    return tokens;
  }

  /** Parses the document and returns its single root value. */
  parse(): PlistValue {
    const opening = this.next();
    if (opening.name !== "plist" || opening.closing) {
      throw new Error("no <plist> root element");
    }
    const root = this.parseValue(this.next());
    const closing = this.next();
    if (closing.name !== "plist" || !closing.closing) {
      throw new Error("the <plist> root is not closed");
    }
    if (this.index !== this.tokens.length) {
      throw new Error("content appears after </plist>");
    }
    return root;
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (!token) throw new Error("the document ended unexpectedly");
    this.index += 1;
    return token;
  }

  private parseValue(token: Token): PlistValue {
    if (token.closing) throw new Error(`unexpected </${token.name}>`);
    switch (token.name) {
      case "true":
        return { kind: "bool", value: true };
      case "false":
        return { kind: "bool", value: false };
      case "string":
      case "integer":
      case "real":
      case "data":
      case "date": {
        if (token.selfClosing) return { kind: token.name, value: "" } as PlistValue;
        const closing = this.next();
        if (!closing.closing || closing.name !== token.name) {
          throw new Error(`<${token.name}> is not closed`);
        }
        return { kind: token.name, value: decodeXmlText(closing.text) } as PlistValue;
      }
      case "array": {
        const items: PlistValue[] = [];
        if (token.selfClosing) return { kind: "array", value: items };
        for (;;) {
          const item = this.next();
          if (item.closing && item.name === "array") return { kind: "array", value: items };
          items.push(this.parseValue(item));
        }
      }
      case "dict": {
        const entries = new Map<string, PlistValue>();
        if (token.selfClosing) return { kind: "dict", value: entries };
        for (;;) {
          const keyToken = this.next();
          if (keyToken.closing && keyToken.name === "dict") {
            return { kind: "dict", value: entries };
          }
          if (keyToken.name !== "key" || keyToken.closing) {
            throw new Error("a <dict> may only contain <key> followed by a value");
          }
          const keyClose = this.next();
          if (!keyClose.closing || keyClose.name !== "key") {
            throw new Error("<key> is not closed");
          }
          const key = decodeXmlText(keyClose.text);
          /*
           * A duplicate key means two readers can disagree about what the file
           * says — `codesign` takes one and a hand reading takes the other.
           * That ambiguity is exactly how an unnoticed capability ships, so it
           * is rejected rather than resolved.
           */
          if (entries.has(key)) throw new Error(`${key} is declared more than once`);
          entries.set(key, this.parseValue(this.next()));
        }
      }
      default:
        throw new Error(`unsupported <${token.name}> element`);
    }
  }
}

function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gu, "&");
}

/** Parses an entitlements plist into its top-level key/value entitlements. */
export function parseEntitlements(plist: string): Map<string, PlistValue> {
  const root = new PlistReader(plist).parse();
  if (root.kind !== "dict") throw new Error("the plist root is not a dictionary");
  return root.value;
}

/** Order-independent, type-aware rendering used for comparison and messages. */
export function canonicalize(value: PlistValue): string {
  switch (value.kind) {
    case "bool":
      return value.value ? "true" : "false";
    case "array":
      return `[${value.value.map(canonicalize).join(",")}]`;
    case "dict":
      return `{${[...value.value.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
        .join(",")}}`;
    default:
      return `${value.kind}(${JSON.stringify(value.value)})`;
  }
}

/** True only when an entitlement is present AND boolean true. */
export function isGranted(value: PlistValue | undefined): boolean {
  return value !== undefined && value.kind === "bool" && value.value;
}

/** Top-level entitlement keys, now derived from the parsed structure. */
export function entitlementKeys(plist: string): string[] {
  return [...parseEntitlements(plist).keys()];
}

/**
 * Reject any entitlement at all on a binary that is supposed to carry none.
 *
 * Structural rather than textual. The previous gate asked whether the blob
 * contained the substring `<key>`, which `<key >com.apple.security.get-task-allow</key>`
 * — well-formed XML that the loader honours — does not. Everything that decides
 * what a plist grants now goes through one parser.
 *
 * Returns the keys found, which is always empty on the accepting path.
 */
export function assertUnprivileged({
  label,
  signedPlist,
  fail,
}: {
  label: string;
  signedPlist: string;
  fail: (message: string) => never;
}): string[] {
  // `codesign` prints nothing for a binary signed without an entitlements
  // blob. An empty `<dict/>` is the other spelling of the same thing, and is
  // handled by the parse below.
  if (signedPlist.trim().length === 0) return [];
  let keys: string[];
  try {
    keys = entitlementKeys(signedPlist);
  } catch (error) {
    // Unreadable is a rejection. "We could not parse it" must never be
    // reported as "it carries nothing".
    return fail(
      `${label} has an entitlements blob that could not be read: ${(error as Error).message}\n${signedPlist}`,
    );
  }
  if (keys.length > 0) {
    fail(`${label} unexpectedly carries privileged entitlements: ${keys.join(", ")}\n${signedPlist}`);
  }
  return keys;
}

/**
 * Compare the signed app's entitlements with the plist that declared them.
 *
 * Returns the signed keys so the caller can report exactly what shipped.
 * Throws with a message naming every divergence.
 */
export function assertMainAppEntitlements({
  declaredPlist,
  signedPlist,
  fail,
}: {
  declaredPlist: string;
  signedPlist: string;
  fail: (message: string) => never;
}): string[] {
  const parse = (label: string, source: string): Map<string, PlistValue> => {
    try {
      return parseEntitlements(source);
    } catch (error) {
      return fail(`${label} could not be parsed: ${(error as Error).message}`);
    }
  };
  const declared = parse("resources/entitlements.mac.plist", declaredPlist);
  const signed = parse("the main app's signed entitlements", signedPlist);

  for (const required of REQUIRED_ENTITLEMENTS) {
    if (!isGranted(declared.get(required))) {
      fail(`resources/entitlements.mac.plist no longer grants ${required}`);
    }
  }
  const declaredEscapes = [...declared.keys()].filter((key) => FORBIDDEN_ENTITLEMENTS.has(key));
  if (declaredEscapes.length > 0) {
    fail(
      `resources/entitlements.mac.plist declares hardened-runtime escapes: ${declaredEscapes.join(", ")}`,
    );
  }

  /*
   * A forbidden entitlement is rejected wherever it appears in the signature
   * and whatever it is set to. `get-task-allow` set to `false` is still a
   * release that talks about being debuggable, and the exact-set comparison
   * below would otherwise only catch it as an "unexpected" key with a less
   * useful message.
   */
  const signedEscapes = [...signed.keys()].filter((key) => FORBIDDEN_ENTITLEMENTS.has(key));
  if (signedEscapes.length > 0) {
    fail(`the main app carries hardened-runtime escapes: ${signedEscapes.join(", ")}`);
  }

  const missing = [...declared.keys()].filter((key) => !signed.has(key));
  if (missing.length > 0) fail(`the main app is missing ${missing.join(", ")}`);

  const unexpected = [...signed.keys()].filter((key) => !declared.has(key));
  if (unexpected.length > 0) {
    fail(
      `the main app carries entitlements the release plist does not declare: ${unexpected.join(", ")}`,
    );
  }

  // Same keys on both sides. Now compare what each key is actually set to —
  // the step whose absence let two `false` values pass as two capabilities.
  const divergent: string[] = [];
  for (const [key, declaredValue] of declared) {
    const signedValue = signed.get(key);
    if (signedValue === undefined) continue;
    if (canonicalize(declaredValue) !== canonicalize(signedValue)) {
      divergent.push(
        `${key} (declared ${canonicalize(declaredValue)}, signed ${canonicalize(signedValue)})`,
      );
    }
  }
  if (divergent.length > 0) {
    fail(`the main app's entitlement values differ from the release plist: ${divergent.join("; ")}`);
  }

  // Belt and braces: the required capabilities must be granted in the
  // signature itself, not merely equal to whatever the plist happened to say.
  for (const required of REQUIRED_ENTITLEMENTS) {
    if (!isGranted(signed.get(required))) fail(`the main app does not grant ${required}`);
  }

  return [...signed.keys()];
}
