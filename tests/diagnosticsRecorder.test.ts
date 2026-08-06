import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The recorder is the only evidence a failed dictation leaves behind: the
 * packaged app's stdout and stderr go to /dev/null, so without this file a
 * failure is invisible in the app, in Console.app, and in `log show`.
 *
 * It had no tests at all. The three properties it promises are exactly the
 * three that are dangerous to get wrong, and none of them can be checked by
 * reading the source:
 *
 *   - it must never grow without bound,
 *   - it must never become the reason dictation fails,
 *   - it must never contain user content.
 *
 * So these drive the real class against a real directory, and inject real
 * write and remove failures rather than asserting on source text.
 */

const faults = vi.hoisted(() => ({
  appendFile: null as null | (() => Error),
  rm: null as null | (() => Error),
  rename: null as null | (() => Error),
  mkdir: null as null | (() => Error),
  stat: null as null | (() => Error),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const wrap = <K extends keyof typeof faults>(name: K, real: (...args: never[]) => unknown) =>
    (...args: never[]) => {
      const fault = faults[name];
      if (fault) return Promise.reject(fault());
      return real(...args);
    };
  return {
    ...actual,
    appendFile: wrap("appendFile", actual.appendFile),
    rm: wrap("rm", actual.rm),
    rename: wrap("rename", actual.rename),
    mkdir: wrap("mkdir", actual.mkdir),
    stat: wrap("stat", actual.stat),
  };
});

const { DiagnosticsRecorder, nullDiagnosticsRecorder } = await import(
  "../src/main/diagnostics/diagnosticsRecorder"
);

const IDENTITY = {
  version: "0.1.0-dev.5",
  platform: "darwin",
  arch: "arm64",
  electron: "43.0.0",
};

const SESSION = "11111111-2222-4333-8444-555555555555";

/* Longest detail the allowlist accepts, so rotation is reached in far fewer
 * writes than short fillers would need. */
const FILLER = "f".repeat(56);

let directory: string;

function makeRecorder(): InstanceType<typeof DiagnosticsRecorder> {
  return new DiagnosticsRecorder(directory, IDENTITY);
}

function currentLog(): string {
  const file = path.join(directory, "diagnostics.log");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function previousLog(): string {
  const file = path.join(directory, "diagnostics.1.log");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function lines(content: string): Array<Record<string, unknown>> {
  return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "localscribe-diagnostics-"));
  for (const key of Object.keys(faults) as Array<keyof typeof faults>) faults[key] = null;
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("writing the trail", () => {
  it("stamps the build identity once, ahead of the events", async () => {
    const recorder = makeRecorder();
    recorder.record({ stage: "session", event: "started", outcome: "ok" });
    recorder.record({ stage: "session", event: "finished", outcome: "ok" });
    await recorder.flush();

    const written = lines(currentLog());
    expect(written[0]).toMatchObject({ kind: "localscribe-diagnostics", version: "0.1.0-dev.5" });
    expect(written.filter((entry) => entry.kind === "localscribe-diagnostics")).toHaveLength(1);
    expect(written.slice(1).map((entry) => entry.event)).toEqual(["started", "finished"]);
  });

  /*
   * `record` returns void so no caller can await diagnostics, which means
   * ordering is the queue's job alone.
   */
  it("keeps events in call order without the caller awaiting anything", async () => {
    const recorder = makeRecorder();
    for (let index = 0; index < 40; index += 1) {
      recorder.record({ stage: "session", event: `event-${index}`, outcome: "ok" });
    }
    await recorder.flush();

    expect(lines(currentLog()).slice(1).map((entry) => entry.event))
      .toEqual(Array.from({ length: 40 }, (_, index) => `event-${index}`));
  });

  it("creates the directory and the file with owner-only permissions", async () => {
    const nested = path.join(directory, "nested", "deeper");
    const recorder = new DiagnosticsRecorder(nested, IDENTITY);
    recorder.record({ stage: "session", event: "started", outcome: "ok" });
    await recorder.flush();

    if (process.platform === "win32") return;
    expect(statSync(nested).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(nested, "diagnostics.log")).mode & 0o777).toBe(0o600);
  });

  it("resumes an existing file rather than truncating it", async () => {
    const first = makeRecorder();
    first.record({ stage: "session", event: "before-restart", outcome: "ok" });
    await first.flush();

    const second = makeRecorder();
    second.record({ stage: "session", event: "after-restart", outcome: "ok" });
    await second.flush();

    const events = lines(currentLog()).filter((entry) => entry.event !== undefined);
    expect(events.map((entry) => entry.event)).toEqual(["before-restart", "after-restart"]);
  });
});

describe("staying bounded", () => {
  it("rotates into a single previous file and starts the new one with a header", async () => {
    const recorder = makeRecorder();
    // Each event is well under a kilobyte; 512KiB is the rotation threshold.
    for (let index = 0; index < 5_000; index += 1) {
      recorder.record({ stage: "session", event: "filler", outcome: "ok", detail: `${FILLER}${index}` });
    }
    await recorder.flush();

    expect(previousLog().length).toBeGreaterThan(0);
    expect(lines(previousLog())[0]).toMatchObject({ kind: "localscribe-diagnostics" });
    expect(lines(currentLog())[0]).toMatchObject({ kind: "localscribe-diagnostics" });
  });

  it("never keeps more than the two rotation files", async () => {
    const recorder = makeRecorder();
    for (let index = 0; index < 12_000; index += 1) {
      recorder.record({ stage: "session", event: "filler", outcome: "ok", detail: `${FILLER}${index}` });
    }
    await recorder.flush();

    const { readdirSync } = await import("node:fs");
    expect(readdirSync(directory).sort()).toEqual(["diagnostics.1.log", "diagnostics.log"]);
  });

  it("keeps the whole trail small enough to paste into a bug report", async () => {
    const recorder = makeRecorder();
    for (let index = 0; index < 12_000; index += 1) {
      recorder.record({ stage: "session", event: "filler", outcome: "ok", detail: `${FILLER}${index}` });
    }
    await recorder.flush();

    expect(currentLog().length + previousLog().length).toBeLessThanOrEqual(2 * 512 * 1024 + 4096);
  });
});

/*
 * The property that matters most in the session path: a recorder that cannot
 * write must degrade to silence, never to a rejection. `record` is called from
 * inside dictation, and a logger that threw there would be a worse bug than the
 * one it was added to diagnose.
 */
describe("failing to write is never the application's problem", () => {
  it.each([
    ["appendFile", "ENOSPC: no space left on device"],
    ["mkdir", "EACCES: permission denied"],
    ["stat", "EIO: i/o error"],
  ] as const)("survives a %s failure without rejecting", async (operation, message) => {
    faults[operation] = () => new Error(message);
    const recorder = makeRecorder();

    expect(() => recorder.record({ stage: "session", event: "started", outcome: "ok" })).not.toThrow();
    await expect(recorder.flush()).resolves.toBeUndefined();
  });

  it("survives an rm failure during rotation", async () => {
    const recorder = makeRecorder();
    faults.rm = () => new Error("EPERM: operation not permitted");
    for (let index = 0; index < 5_000; index += 1) {
      recorder.record({ stage: "session", event: "filler", outcome: "ok", detail: `${FILLER}${index}` });
    }

    await expect(recorder.flush()).resolves.toBeUndefined();
  });

  it("survives a rename failure during rotation", async () => {
    const recorder = makeRecorder();
    faults.rename = () => new Error("EXDEV: cross-device link not permitted");
    for (let index = 0; index < 5_000; index += 1) {
      recorder.record({ stage: "session", event: "filler", outcome: "ok", detail: `${FILLER}${index}` });
    }

    await expect(recorder.flush()).resolves.toBeUndefined();
  });

  /*
   * A transient failure must not poison the queue. The queue is a single
   * promise chain, so a rejection that was not absorbed would silently stop
   * every later event.
   */
  it("keeps recording after a write failure clears", async () => {
    const recorder = makeRecorder();
    faults.appendFile = () => new Error("ENOSPC: no space left on device");
    recorder.record({ stage: "session", event: "lost", outcome: "failed" });
    await recorder.flush();

    faults.appendFile = null;
    recorder.record({ stage: "session", event: "recovered", outcome: "ok" });
    await recorder.flush();

    expect(currentLog()).toContain("recovered");
  });

  it("survives clear() failing to remove the files", async () => {
    const recorder = makeRecorder();
    recorder.record({ stage: "session", event: "started", outcome: "ok" });
    await recorder.flush();

    faults.rm = () => new Error("EPERM: operation not permitted");
    await expect(recorder.clear()).resolves.toBeUndefined();
  });
});

describe("never containing user content", () => {
  it("drops fields that are not on the allowlist", async () => {
    const recorder = makeRecorder();
    recorder.record({
      stage: "session",
      event: "finished",
      outcome: "ok",
      // Exactly the shape of an accidental transcript leak.
      transcript: "my bank password is hunter2",
      audioPath: "/Users/example/Library/Application Support/LocalScribe/audio/a.wav",
    } as never);
    await recorder.flush();

    expect(currentLog()).not.toContain("hunter2");
    expect(currentLog()).not.toContain("/Users/example");
  });

  it("drops a session id that is not actually a generated id", async () => {
    const recorder = makeRecorder();
    recorder.record({ stage: "session", event: "finished", outcome: "ok", sessionId: SESSION });
    recorder.record({ stage: "session", event: "finished", outcome: "ok", sessionId: "the meeting notes" as never });
    await recorder.flush();

    const events = lines(currentLog()).slice(1);
    expect(events[0]?.sessionId).toBe(SESSION);
    expect(events[1]?.sessionId).toBeUndefined();
    expect(currentLog()).not.toContain("meeting notes");
  });

  it("truncates long free text rather than writing it", async () => {
    const recorder = makeRecorder();
    recorder.record({
      stage: "session",
      event: "failed",
      outcome: "failed",
      detail: "a".repeat(400),
    });
    await recorder.flush();

    expect(() => lines(currentLog())).not.toThrow();
    expect(currentLog()).not.toMatch(/"[^"]{65,}"/u);
  });

  /*
   * A file written by an older build, before a redaction fix, must not reach
   * the clipboard just because it is already on disk.
   */
  it("withholds a file on disk that fails the redaction check", async () => {
    const recorder = makeRecorder();
    recorder.record({ stage: "session", event: "started", outcome: "ok" });
    await recorder.flush();

    writeFileSync(
      path.join(directory, "diagnostics.log"),
      `${JSON.stringify({ stage: "session", event: "leak", detail: "https://example.com/model" })}\n`,
    );

    const read = await recorder.read();
    expect(read).toMatch(/withheld the diagnostics file/u);
    expect(read).not.toContain("https://");
  });
});

describe("reading the trail back", () => {
  it("returns the rotated file before the current one", async () => {
    const recorder = makeRecorder();
    for (let index = 0; index < 5_000; index += 1) {
      recorder.record({ stage: "session", event: "filler", outcome: "ok", detail: `${FILLER}${index}` });
    }
    recorder.record({ stage: "session", event: "newest", outcome: "ok" });
    await recorder.flush();

    const read = await recorder.read();
    expect(read.indexOf("newest")).toBeGreaterThan(0);
    expect(read.startsWith(previousLog().slice(0, 40))).toBe(true);
  });

  it("returns nothing rather than failing when no trail exists yet", async () => {
    await expect(makeRecorder().read()).resolves.toBe("");
  });

  it("removes both files on clear", async () => {
    const recorder = makeRecorder();
    for (let index = 0; index < 5_000; index += 1) {
      recorder.record({ stage: "session", event: "filler", outcome: "ok", detail: `${FILLER}${index}` });
    }
    await recorder.flush();
    expect(previousLog().length).toBeGreaterThan(0);

    await recorder.clear();

    expect(existsSync(path.join(directory, "diagnostics.log"))).toBe(false);
    expect(existsSync(path.join(directory, "diagnostics.1.log"))).toBe(false);
  });

  it("writes a fresh header after a clear rather than resuming a stale byte count", async () => {
    const recorder = makeRecorder();
    recorder.record({ stage: "session", event: "before", outcome: "ok" });
    await recorder.flush();
    await recorder.clear();

    recorder.record({ stage: "session", event: "after", outcome: "ok" });
    await recorder.flush();

    const written = lines(currentLog());
    expect(written[0]).toMatchObject({ kind: "localscribe-diagnostics" });
    expect(written.map((entry) => entry.event)).not.toContain("before");
  });
});

describe("the null recorder", () => {
  it("accepts the same calls and keeps the session path free of null checks", async () => {
    expect(() => nullDiagnosticsRecorder.record()).not.toThrow();
    await expect(nullDiagnosticsRecorder.flush()).resolves.toBeUndefined();
    await expect(nullDiagnosticsRecorder.read()).resolves.toBe("");
    await expect(nullDiagnosticsRecorder.clear()).resolves.toBeUndefined();
  });
});
