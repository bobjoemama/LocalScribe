import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DIAGNOSTICS_COPIED_STATUS } from "../src/renderer/settings/screens/StyleSettings";
import { FORBIDDEN_DIAGNOSTIC_PATTERNS } from "../src/shared/diagnosticsLog";
import { expectPrecedes, requireIndex, sliceBetween, sliceFollowing } from "./support/order";

/*
 * The packaged app writes stdout and stderr to /dev/null. When a dictation
 * fails there is nothing in the app, nothing in Console.app, and nothing in
 * `log show`, so the only way to find out what happened was to rebuild with a
 * console attached — which replaces the build being diagnosed. This control is
 * the one route the failure trail has off the machine.
 */

const modal = readFileSync("src/renderer/settings/screens/StyleSettings.tsx", "utf8");
const main = readFileSync("src/main.ts", "utf8");
const preload = readFileSync("src/preload.ts", "utf8");
const handler = sliceBetween(modal, "const copyDiagnostics = async", "const installModel = async");
const clearHandler = sliceBetween(modal, "const clearDiagnostics = async", "const copyDiagnostics = async");

describe("what the control tells the user it copied", () => {
  it("says what the trail contains and what it does not", () => {
    // They are being asked to paste this into an issue tracker, so the message
    // has to answer "what am I about to make public?".
    expect(DIAGNOSTICS_COPIED_STATUS).toMatch(/transcripts/u);
    expect(DIAGNOSTICS_COPIED_STATUS).toMatch(/never/u);
  });

  it("does not itself violate the redaction rules it describes", () => {
    for (const { name, pattern } of FORBIDDEN_DIAGNOSTIC_PATTERNS) {
      expect(
        pattern.test(DIAGNOSTICS_COPIED_STATUS),
        `the copy confirmation contains a ${name}`,
      ).toBe(false);
    }
  });
});

describe("copying the trail", () => {
  it("reads through the main-process channel rather than touching the file", () => {
    // The renderer has no business knowing where the log lives, and the
    // main-process read is what re-checks redaction on the way out.
    expect(handler).toContain("window.localScribe.system.diagnosticsLog()");
    expect(handler).not.toMatch(/readFile|node:fs|dataPath/u);
  });

  it("does not re-filter content that main already redacted", () => {
    /*
     * A second, weaker rule in the renderer could silently disagree with the
     * real one — and the failure mode of disagreeing is shipping unredacted
     * content while believing it was filtered.
     */
    expect(handler).not.toMatch(/replace\(|redact|sanitize|FORBIDDEN/u);
  });

  it("writes to the clipboard only after a successful read", () => {
    expectPrecedes(handler, "diagnosticsLog()", "navigator.clipboard.writeText(trail)");
  });

  it("announces success only once the write has resolved", () => {
    /*
     * Setting the status first and awaiting afterwards puts "copied" on screen
     * while the clipboard write is still outstanding, so a denied clipboard
     * permission shows success and then retracts it.
     */
    expectPrecedes(
      handler,
      "navigator.clipboard.writeText(trail)",
      "setStatus(DIAGNOSTICS_COPIED_STATUS)",
    );
  });

  it("reports a read failure instead of copying nothing and claiming success", () => {
    const readFailure = sliceBetween(handler, "} catch (error) {", "return;");

    expect(readFailure).toContain("Could not read the diagnostics log");
    expect(handler).not.toMatch(/catch \{\s*\}/u);
  });

  it("reports a clipboard failure separately from a read failure", () => {
    // These fail for different reasons and have different remedies, so one
    // message for both would send the user to the wrong place.
    expect(handler).toContain("Could not copy the diagnostics log");
    expect(handler).toContain("Could not read the diagnostics log");
  });

  /*
   * An empty trail is not an error: nothing has gone wrong yet. Reporting
   * "copied" would leave the user pasting an empty block into a bug report and
   * wondering why nobody could help.
   */
  it("distinguishes an empty trail from a failure", () => {
    // The read is wrapped in its own `try {` above, so anchor on the branch and
    // take the `try {` that follows it rather than the first one in the handler.
    const empty = sliceFollowing(handler, "if (trail.trim().length === 0)", "try {");

    expect(empty).toContain("No diagnostics have been recorded yet");
    expect(empty).toContain("return;");
    expectPrecedes(handler, "trail.trim().length === 0", "navigator.clipboard.writeText");
  });

  it("does not announce success on a path that copied nothing", () => {
    const success = handler.slice(requireIndex(handler, "DIAGNOSTICS_COPIED_STATUS"));

    expect(success).not.toContain("No diagnostics have been recorded yet");
  });
});

describe("the control itself", () => {
  const actions = sliceFollowing(modal, 'className="ls-data-actions"', "</div>");

  it("sits with the other data actions on the privacy screen", () => {
    expect(actions).toContain("Copy diagnostics");
    expect(actions).toContain("void copyDiagnostics()");
  });

  it("warns in the control what the log excludes, before it is pressed", () => {
    // The reassurance has to be visible at the moment of deciding, not only in
    // the confirmation after the clipboard already holds the content.
    expect(actions).toMatch(/Copy diagnostics<\/strong><small>[^<]*no transcripts or paths/u);
  });

  it("is not styled as a destructive action, because it changes nothing", () => {
    const button = sliceFollowing(actions, "void copyDiagnostics()", "</button>");

    expect(button).not.toContain("is-danger");
  });
});

describe("clearing the trail", () => {
  it("routes the API through main instead of exposing a diagnostics path", () => {
    expect(preload).toContain("ipcRenderer.invoke(IPC.systemClearDiagnostics)");
    expect(main).toContain("handle(IPC.systemClearDiagnostics, () => diagnostics.clear())");
    expect(clearHandler).not.toMatch(/node:fs|\b(?:rm|unlink|truncate)\s*\(/u);
  });

  it("requires confirmation before invoking the Settings-only clear API", () => {
    expectPrecedes(clearHandler, "window.confirm", "window.localScribe.system.clearDiagnostics()");
    expect(clearHandler).toContain("if (!window.confirm");
  });

  it("announces success only after main confirms the clear", () => {
    expectPrecedes(
      clearHandler,
      "await window.localScribe.system.clearDiagnostics()",
      'setStatus("Diagnostics log cleared")',
    );
    expect(clearHandler).toContain("Could not clear the diagnostics log");
  });

  it("shows the destructive control beside the other diagnostics actions", () => {
    const actions = sliceFollowing(modal, 'className="ls-data-actions"', "</div>");
    expect(actions).toContain("Clear diagnostics");
    expect(actions).toContain("void clearDiagnostics()");
    expect(sliceFollowing(actions, "void clearDiagnostics()", "</button>"))
      .toContain("is-danger");
    expect(sliceFollowing(actions, "void clearDiagnostics()", "</button>"))
      .not.toMatch(/permanent/iu);
  });
});
