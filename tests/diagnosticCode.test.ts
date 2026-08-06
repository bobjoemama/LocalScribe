import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_DIAGNOSTIC_PATTERNS,
  KNOWN_ERROR_CODES,
  normalizeDiagnosticCode,
} from "../src/shared/diagnosticsLog";

/*
 * What the diagnostics log is for is telling one failure apart from another.
 *
 * It could not. Every failure that main rewrapped for the user, and every
 * failure of the worker process itself, normalized to `Error:len<n>` — so a
 * missing model, a crashed worker and a wedged one arrived in a bug report as
 * three anonymous numbers, and `worker_exited` / `worker_timeout` were in the
 * known-code set but unreachable from any message the app produces.
 *
 * The constraint that made it that way is real and is not relaxed here: an
 * error message may contain the user's home directory, a model URL, or the text
 * being inserted, so nothing from a message is ever echoed. Only a member of
 * the closed set is returned, which is what makes widening the *search* safe.
 */

/** An error tagged the way the supervisor tags its own process failures. */
function tagged(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("codes carried in a wrapped cause", () => {
  it("finds the code main hid behind a sentence the user can act on", () => {
    // Verbatim from workerSupervisor.ts: the worker's structured failure is
    // rewrapped with actionable instructions and passed as `cause`.
    const rewrapped = new Error(
      "Local speech model is not installed. Open LocalScribe Settings > Model & Performance"
      + " to install it before dictating.",
      { cause: new Error("model_not_installed") },
    );

    expect(normalizeDiagnosticCode(rewrapped)).toBe("model_not_installed");
  });

  it("looks through more than one layer of wrapping", () => {
    const outer = new Error("Dictation failed", {
      cause: new Error("could not load the model", {
        cause: new Error("model_load_failed"),
      }),
    });

    expect(normalizeDiagnosticCode(outer)).toBe("model_load_failed");
  });

  it("terminates on a cause chain that points back at itself", () => {
    /*
     * `cause` is arbitrary input as far as this module is concerned, and a
     * diagnostics writer must never be the thing that hangs the app.
     */
    const first: Error & { cause?: unknown } = new Error("first");
    const second = new Error("second", { cause: first });
    first.cause = second;

    expect(normalizeDiagnosticCode(first)).toBe("Error:len5");
  });

  it("stops walking rather than following an unbounded chain", () => {
    let error = new Error("model_not_installed");
    for (let depth = 0; depth < 40; depth += 1) error = new Error("wrapped", { cause: error });

    // Not found, and — the point of the test — it returns at all.
    expect(normalizeDiagnosticCode(error)).toBe("Error:len7");
  });
});

describe("codes the supervisor carries as a property", () => {
  /*
   * These three are facts about the child process rather than replies from it,
   * so there is no protocol message to read them out of.
   */
  it("distinguishes a crashed worker from a wedged one", () => {
    expect(normalizeDiagnosticCode(tagged("ASR worker exited (1)", "worker_exited")))
      .toBe("worker_exited");
    expect(normalizeDiagnosticCode(tagged("ASR worker did not start in time", "worker_timeout")))
      .toBe("worker_timeout");
    expect(normalizeDiagnosticCode(
      tagged("ASR worker request timed out: transcribe", "worker_timeout"),
    )).toBe("worker_timeout");
  });

  it("ignores a code property that is not one of ours", () => {
    // Node's own errors carry `code`. `ENOENT` is not a LocalScribe code and
    // must not be written as though it were.
    const failure = Object.assign(
      new Error("ENOENT: no such file or directory, open '/Users/someone/x'"),
      { code: "ENOENT" },
    );

    expect(normalizeDiagnosticCode(failure)).toBe(`Error:len${failure.message.length}`);
  });

  it("ignores a non-string code", () => {
    expect(normalizeDiagnosticCode(Object.assign(new Error("boom"), { code: 7 })))
      .toBe("Error:len4");
  });
});

describe("codes appearing anywhere in the message", () => {
  it("finds a code that is not the first word", () => {
    // "ASR worker exited" made the scan stop on `worker`, which is not a code,
    // and it never looked at the rest of the message.
    expect(normalizeDiagnosticCode(new Error("the worker reported audio_too_long")))
      .toBe("audio_too_long");
  });

  it("still prefers a real code over a word that merely looks like one", () => {
    expect(normalizeDiagnosticCode(new Error("speech failed: no_speech_detected")))
      .toBe("no_speech_detected");
  });
});

describe("what is never written", () => {
  it("reduces an ordinary message to a name and a length", () => {
    const failure = new Error("Could not read /Users/devesh/Library/Application Support/LocalScribe");

    const code = normalizeDiagnosticCode(failure);

    expect(code).toBe(`Error:len${failure.message.length}`);
    expect(code).not.toContain("devesh");
    expect(code).not.toContain("/");
  });

  it("never returns anything outside the closed set or the name:len shape", () => {
    /*
     * The property that makes searching the whole message and the whole cause
     * chain safe. Driven with messages built to look like leaks.
     */
    const hostile = [
      new Error("/Users/devesh/Library/Application Support/LocalScribe/history.db"),
      new Error("https://huggingface.co/mlx-community/whisper-large-v3-turbo"),
      new Error("token sk-ant-0000000000", { cause: new Error("/Users/devesh/x") }),
      new Error("cancelled by /Users/devesh"),
      tagged("/Users/devesh", "worker_exited"),
      new Error("no code here at all"),
    ];

    for (const failure of hostile) {
      const code = normalizeDiagnosticCode(failure);
      const allowed = KNOWN_ERROR_CODES.has(code) || /^[A-Za-z]+:len\d+$/u.test(code);
      expect(allowed, `${code} is neither a known code nor a name:len token`).toBe(true);
      for (const { name, pattern } of FORBIDDEN_DIAGNOSTIC_PATTERNS) {
        expect(pattern.test(code), `the code contains a ${name}`).toBe(false);
      }
    }
  });

  it("keeps its behaviour for values that are not errors at all", () => {
    expect(normalizeDiagnosticCode(undefined)).toBe("undefined");
    expect(normalizeDiagnosticCode(null)).toBe("null");
    expect(normalizeDiagnosticCode(42)).toBe("number");
    expect(normalizeDiagnosticCode("cancelled")).toBe("cancelled");
    // A string that is not a safe token is not echoed.
    expect(normalizeDiagnosticCode("/Users/devesh/Library")).toBe("string");
  });
});

describe("the known-code set is reachable", () => {
  /*
   * `worker_exited` and `worker_timeout` were listed here and produced by
   * nothing, which is the failure this test exists to keep from returning: a
   * code in the set that no code path can emit is documentation, not
   * diagnostics.
   */
  it("emits every code the set declares, given a message that carries it", () => {
    for (const code of KNOWN_ERROR_CODES) {
      expect(normalizeDiagnosticCode(new Error(`worker failed: ${code}`)), code).toBe(code);
    }
  });

  it("keeps the supervisor tagging its process failures", () => {
    // The two codes above have no textual source, so their reachability rests
    // on the supervisor still attaching them.
    const supervisor = readFileSync("src/main/worker/workerSupervisor.ts", "utf8");

    expect(supervisor).toContain('workerProcessError(`ASR worker exited (');
    expect(supervisor).toMatch(/workerProcessError\(\s*"ASR worker did not start in time",\s*"worker_timeout"/u);
    expect(supervisor).toMatch(/ASR worker request timed out[\s\S]{0,40}"worker_timeout"/u);
  });
});
