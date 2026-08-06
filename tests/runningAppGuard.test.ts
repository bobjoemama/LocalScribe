import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  appBundleFor,
  assertNoRunningPackagedApp,
  groupByBundle,
  listMacProcesses,
  parseProcessList,
  processesInside,
  runningAppMessage,
  type RunningProcess,
} from "../scripts/running-app-guard";
import { expectPrecedes, sliceBetween } from "./support/order";

/*
 * A packaged build overwrote `app.asar` and the main executable of a
 * LocalScribe that was still running out of the same bundle. Electron kept the
 * main process it had already loaded and paired it with the newly written
 * renderer, so the running app became a mixture of two builds. The symptoms
 * were blamed on the speech model, the hotkey path, and the recorder in turn;
 * none of them were at fault, and the build reported nothing, because writing
 * the files had succeeded.
 */

const OUT = "/Users/example/LocalScribe/out";
const BUNDLE = `${OUT}/LocalScribe-darwin-arm64/LocalScribe.app`;

function running(pid: number, executablePath: string): RunningProcess {
  return { pid, executablePath };
}

describe("detecting a LocalScribe running out of the output directory", () => {
  it("finds the app that is about to be overwritten", () => {
    const conflicts = processesInside(OUT, [
      running(1, "/sbin/launchd"),
      running(73523, `${BUNDLE}/Contents/MacOS/LocalScribe`),
    ]);

    expect(conflicts).toEqual([running(73523, `${BUNDLE}/Contents/MacOS/LocalScribe`)]);
  });

  it("finds the helper processes inside the bundle too", () => {
    const helper = `${BUNDLE}/Contents/Frameworks/LocalScribe Helper (Renderer).app/Contents/MacOS/LocalScribe Helper (Renderer)`;
    const conflicts = processesInside(OUT, [
      running(73528, helper),
      running(73523, `${BUNDLE}/Contents/MacOS/LocalScribe`),
    ]);

    expect(conflicts.map((entry) => entry.pid)).toEqual([73523, 73528]);
  });

  /*
   * The separate /Applications install is a different set of files. Blocking on
   * it would refuse builds for a process the build cannot damage, and the
   * fastest way to get a safety guard removed is to make it wrong.
   */
  it("ignores a LocalScribe installed somewhere the build will not write", () => {
    expect(processesInside(OUT, [
      running(400, "/Applications/LocalScribe.app/Contents/MacOS/LocalScribe"),
    ])).toEqual([]);
  });

  it("ignores a sibling directory whose name merely starts the same way", () => {
    expect(processesInside(OUT, [
      running(401, "/Users/example/LocalScribe/out-old/LocalScribe.app/Contents/MacOS/LocalScribe"),
    ])).toEqual([]);
  });

  it("ignores the development Electron, which runs from node_modules", () => {
    expect(processesInside(OUT, [
      running(402, "/Users/example/LocalScribe/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
    ])).toEqual([]);
  });
});

describe("naming something the user can actually quit", () => {
  it("reports the outermost bundle, not the helper", () => {
    const helper = `${BUNDLE}/Contents/Frameworks/LocalScribe Helper.app/Contents/MacOS/LocalScribe Helper`;

    expect(appBundleFor(helper)).toBe(BUNDLE);
  });

  it("collapses every process of one app into a single line", () => {
    const grouped = groupByBundle([
      running(73528, `${BUNDLE}/Contents/Frameworks/LocalScribe Helper.app/Contents/MacOS/LocalScribe Helper`),
      running(73523, `${BUNDLE}/Contents/MacOS/LocalScribe`),
      running(73530, `${BUNDLE}/Contents/Frameworks/LocalScribe Helper (GPU).app/Contents/MacOS/LocalScribe Helper (GPU)`),
    ]);

    expect(grouped).toEqual([{ bundle: BUNDLE, pids: [73523, 73528, 73530] }]);
  });

  it("falls back to the executable path when there is no bundle", () => {
    expect(appBundleFor("/usr/local/bin/localscribe")).toBeNull();
    expect(groupByBundle([running(9, "/usr/local/bin/localscribe")])).toEqual([
      { bundle: "/usr/local/bin/localscribe", pids: [9] },
    ]);
  });
});

describe("the refusal itself", () => {
  const conflicts = [
    running(73523, `${BUNDLE}/Contents/MacOS/LocalScribe`),
    running(73528, `${BUNDLE}/Contents/Frameworks/LocalScribe Helper.app/Contents/MacOS/LocalScribe Helper`),
  ];

  it("throws on macOS when the running app would be overwritten", () => {
    expect(() => assertNoRunningPackagedApp({
      outputDirectory: OUT,
      platform: "darwin",
      listProcesses: () => conflicts,
    })).toThrow(/Refusing to package over a LocalScribe that is still running/u);
  });

  it("does not throw when nothing is running from there", () => {
    expect(() => assertNoRunningPackagedApp({
      outputDirectory: OUT,
      platform: "darwin",
      listProcesses: () => [running(1, "/sbin/launchd")],
    })).not.toThrow();
  });

  it("stays out of the way on platforms this repository does not release for", () => {
    // Release scope here is macOS Apple Silicon. A guard that cannot be
    // verified on a platform is worse than no guard on it.
    for (const platform of ["win32", "linux"] as const) {
      expect(() => assertNoRunningPackagedApp({
        outputDirectory: OUT,
        platform,
        listProcesses: () => conflicts,
      })).not.toThrow();
    }
  });

  it("names every PID so the user can find them", () => {
    const message = runningAppMessage(conflicts);

    expect(message).toContain("73523");
    expect(message).toContain("73528");
  });

  it("promises not to kill anything, and says why the build stopped", () => {
    const message = runningAppMessage(conflicts);

    expect(message).toMatch(/will not quit LocalScribe for you/u);
    expect(message).toMatch(/mixture of two builds/u);
    expect(message).toMatch(/Quit it, then run this again/u);
  });

  it("shortens paths against the project root when one is given", () => {
    const message = runningAppMessage(conflicts, "/Users/example/LocalScribe");

    expect(message).toContain("out/LocalScribe-darwin-arm64/LocalScribe.app");
    expect(message).not.toContain("/Users/example");
  });
});

describe("reading the process table", () => {
  it("keeps executable paths that contain spaces intact", () => {
    const parsed = parseProcessList([
      "    1 /sbin/launchd",
      "  590 /Library/Application Support/Razer/Razer Elevation Service.app/Contents/MacOS/Razer Elevation Service",
      "73523 /Users/example/LocalScribe/out/LocalScribe-darwin-arm64/LocalScribe.app/Contents/MacOS/LocalScribe",
      "",
    ].join("\n"));

    expect(parsed).toHaveLength(3);
    expect(parsed[1]?.executablePath).toBe(
      "/Library/Application Support/Razer/Razer Elevation Service.app/Contents/MacOS/Razer Elevation Service",
    );
    expect(parsed[2]?.pid).toBe(73523);
  });

  it("skips header and malformed lines rather than inventing a PID", () => {
    expect(parseProcessList("  PID COMMAND\n\n   not-a-pid /bin/sh\n")).toEqual([]);
  });

  /*
   * A real macOS process table has around 70 rows with no path at all. These
   * are reported faithfully rather than dropped, so the containment check is
   * the single place that decides what counts as inside.
   */
  it("keeps pathless daemon names rather than discarding the row", () => {
    const parsed = parseProcessList("  123 endpointsecurityd\n  124 postgres: checkpointer\n");

    expect(parsed).toEqual([
      { pid: 123, executablePath: "endpointsecurityd" },
      { pid: 124, executablePath: "postgres: checkpointer" },
    ]);
  });

  /*
   * `path.relative` resolves a relative argument against `process.cwd()`, so a
   * bare daemon name would otherwise be judged "inside" or "outside" depending
   * on where the build happened to be invoked from.
   */
  it("never treats a pathless process as being inside the output directory", () => {
    for (const directory of [OUT, process.cwd(), path.join(process.cwd(), "out")]) {
      expect(processesInside(directory, [
        running(123, "endpointsecurityd"),
        running(124, "postgres: checkpointer"),
      ])).toEqual([]);
    }
  });
});

/*
 * The guard is only worth anything if the build actually calls it, and before
 * it writes anything.
 */
describe("the build runs the guard before it writes", () => {
  const config = readFileSync("forge.config.ts", "utf8");

  it("guards both entry points, because package does not run preMake", () => {
    for (const hook of ["preMake: async ()", "prePackage: async (_config"]) {
      const body = config.slice(config.indexOf(hook)).slice(0, 900);
      expect(body).toContain("assertNoRunningPackagedApp({");
    }
  });

  it("checks before compiling the helper or preparing the integrity expectation", () => {
    const prePackage = sliceBetween(config, "prePackage: async (_config", "postPackage:");

    expectPrecedes(prePackage, "assertNoRunningPackagedApp(", "swiftc");
    expectPrecedes(prePackage, "assertNoRunningPackagedApp(", "prepareGeneratedResourceIntegrity(");
  });

  it("guards the whole out directory, not one bundle path", () => {
    const prePackage = sliceBetween(config, "prePackage: async (_config", "postPackage:");

    expect(prePackage).toContain('outputDirectory: path.resolve("out")');
  });

  it("never terminates the process it found", () => {
    const guard = readFileSync("scripts/running-app-guard.ts", "utf8");

    expect(guard).not.toMatch(/process\.kill|SIGTERM|SIGKILL|\bpkill\b|killall/u);
  });
});

describe("the real process table", () => {
  it("parses on this machine without inventing conflicts in the repository", () => {
    // Exercises the real `ps` output shape rather than a fixture. The
    // repository's own out/ directory must not be reported unless a packaged
    // LocalScribe really is running from it right now.
    if (process.platform !== "darwin") return;

    const processes = listMacProcesses();
    expect(processes.length).toBeGreaterThan(0);
    expect(processes.every((entry) => Number.isInteger(entry.pid) && entry.pid > 0)).toBe(true);
    expect(processes.every((entry) => entry.executablePath.length > 0)).toBe(true);
    // Most rows are real executables; the rest are pathless daemons.
    expect(processes.filter((entry) => path.isAbsolute(entry.executablePath)).length)
      .toBeGreaterThan(processes.length / 2);

    // No packaged LocalScribe is running from this checkout right now, so the
    // guard must be silent against the real table.
    expect(processesInside(path.resolve("out"), processes)).toEqual([]);
  });
});
