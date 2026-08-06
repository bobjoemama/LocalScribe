import { execFileSync } from "node:child_process";
import path from "node:path";

/*
 * Refuses to package over a LocalScribe that is currently running.
 *
 * This is the defect that started the investigation this guard came out of. A
 * packaged build wrote `app.asar` and the main executable into
 * `out/LocalScribe-darwin-arm64/LocalScribe.app` while a LocalScribe launched
 * from that exact bundle was still running. Electron had already loaded the old
 * main process into memory, but the renderer had not yet loaded its entry — so
 * the live app finished starting as an old main process paired with a newly
 * written renderer.
 *
 * That mixture behaves like neither build. It produced hours of debugging aimed
 * at the speech model, the hotkey path, and the recorder, none of which were
 * responsible. Nothing in the build reported it, because from the build's point
 * of view writing the files succeeded.
 *
 * The guard reports and stops. It deliberately does not terminate anything:
 * killing a packaged app mid-write is its own way of leaving a half-updated
 * bundle on disk, and an unprompted kill of the user's running app is not a
 * decision a build script gets to make.
 */

export interface RunningProcess {
  pid: number;
  /** Absolute path to the process executable. */
  executablePath: string;
}

export interface RunningAppGuardOptions {
  /** Absolute path the packager is about to write into. */
  outputDirectory: string;
  platform: NodeJS.Platform;
  listProcesses(): readonly RunningProcess[];
  /** Used only to shorten paths in the message. */
  projectPath?: string;
}

/**
 * True when `candidate` sits strictly beneath `directory`.
 *
 * The absolute check is not a formality. About 70 rows of a real macOS process
 * table have no path at all — `endpointsecurityd`, `postgres: checkpointer` —
 * and `path.relative` resolves a relative argument against `process.cwd()`.
 * Without this, whether a kernel daemon counted as "inside the output
 * directory" would depend on the directory the build was invoked from.
 */
function isInside(directory: string, candidate: string): boolean {
  if (!path.isAbsolute(directory) || !path.isAbsolute(candidate)) return false;
  const relative = path.relative(directory, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * The outermost `.app` in a path. Electron helpers live in nested bundles
 * (`LocalScribe.app/Contents/Frameworks/LocalScribe Helper.app/…`), and naming
 * the helper rather than the app the user actually launched would be useless
 * advice — they cannot quit a helper.
 */
export function appBundleFor(executablePath: string): string | null {
  const segments = executablePath.split(path.sep);
  const index = segments.findIndex((segment) => segment.endsWith(".app"));
  if (index === -1) return null;
  return segments.slice(0, index + 1).join(path.sep);
}

/** Every listed process whose executable lives inside the output directory. */
export function processesInside(
  outputDirectory: string,
  processes: readonly RunningProcess[],
): RunningProcess[] {
  return processes
    .filter((entry) => isInside(outputDirectory, entry.executablePath))
    .sort((left, right) => left.pid - right.pid);
}

/** Groups conflicting processes by the bundle a user would quit. */
export function groupByBundle(
  conflicts: readonly RunningProcess[],
): Array<{ bundle: string; pids: number[] }> {
  const byBundle = new Map<string, number[]>();
  for (const conflict of conflicts) {
    const bundle = appBundleFor(conflict.executablePath) ?? conflict.executablePath;
    const pids = byBundle.get(bundle);
    if (pids) pids.push(conflict.pid);
    else byBundle.set(bundle, [conflict.pid]);
  }
  return [...byBundle.entries()]
    .map(([bundle, pids]) => ({ bundle, pids: [...pids].sort((left, right) => left - right) }))
    .sort((left, right) => (left.bundle < right.bundle ? -1 : left.bundle > right.bundle ? 1 : 0));
}

export function runningAppMessage(
  conflicts: readonly RunningProcess[],
  projectPath?: string,
): string {
  const shorten = (value: string): string => {
    if (projectPath === undefined) return value;
    const relative = path.relative(projectPath, value);
    return relative.startsWith("..") || path.isAbsolute(relative) ? value : relative;
  };
  const listed = groupByBundle(conflicts)
    .map(({ bundle, pids }) => `  ${shorten(bundle)}  (PID ${pids.join(", ")})`)
    .join("\n");
  return [
    "Refusing to package over a LocalScribe that is still running.",
    "",
    listed,
    "",
    "Quit it, then run this again.",
    "",
    "Overwriting the bundle of a live app replaces app.asar and the executable",
    "underneath the running process. Electron keeps the main process it already",
    "loaded and pairs it with the newly written renderer, so the app that stays",
    "on screen is a mixture of two builds and behaves like neither. Nothing",
    "reports it afterwards, because the files were written successfully.",
    "",
    "This build will not quit LocalScribe for you.",
  ].join("\n");
}

/**
 * Throws when a process running out of `outputDirectory` would be overwritten.
 *
 * Scoped to macOS: this repository's release scope is macOS Apple Silicon, and
 * a guard for a platform that cannot be verified here would be worse than none.
 */
export function assertNoRunningPackagedApp(options: RunningAppGuardOptions): void {
  if (options.platform !== "darwin") return;
  const conflicts = processesInside(options.outputDirectory, options.listProcesses());
  if (conflicts.length === 0) return;
  throw new Error(runningAppMessage(conflicts, options.projectPath));
}

/** `pid` then the full executable path, which may itself contain spaces. */
export function parseProcessList(output: string): RunningProcess[] {
  const processes: RunningProcess[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(.*\S)\s*$/u.exec(line);
    if (!match?.[1] || !match[2]) continue;
    processes.push({ pid: Number.parseInt(match[1], 10), executablePath: match[2] });
  }
  return processes;
}

/**
 * Fails closed. If the process table cannot be read, the guard cannot tell
 * whether it is about to corrupt a running app, and silently assuming it is not
 * is the assumption that caused the mixed-runtime build in the first place.
 */
export function listMacProcesses(): RunningProcess[] {
  let output: string;
  try {
    output = execFileSync("ps", ["-Ao", "pid=,comm="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    throw new Error(
      "Could not read the process list to check for a running LocalScribe. Refusing to package, because overwriting a running app silently produces a mixed-runtime build.",
      { cause: error },
    );
  }
  return parseProcessList(output);
}
