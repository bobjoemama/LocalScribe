import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  assertRedacted,
  formatDiagnosticHeader,
  formatDiagnosticLine,
  type DiagnosticBuildIdentity,
  type DiagnosticEvent,
} from "../../shared/diagnosticsLog";

/**
 * Bounded, rotating, privacy-checked failure trail.
 *
 * The packaged app's stdout and stderr go to /dev/null, so a dictation that
 * failed left no evidence anywhere: not in the app, not in Console.app, not in
 * `log show`. Diagnosing it meant rebuilding with a console attached, which
 * replaces the build being diagnosed.
 *
 * Three properties matter more than completeness here:
 *
 *  - It must never grow without bound. Two files of 512KiB each is enough to
 *    hold several thousand events, which is many sessions, and is small enough
 *    to paste into a bug report.
 *  - It must never become the reason dictation fails. Every write is
 *    fire-and-forget through a serialized queue, and every error inside this
 *    module is swallowed. A logger that can throw into the session path would
 *    be a worse bug than the one it was added to diagnose.
 *  - It must never contain user content. `formatDiagnosticLine` applies the
 *    field allowlist and `assertRedacted` re-checks the rendered bytes, so a
 *    field that somehow carried a transcript is dropped at the door rather
 *    than written and regretted.
 */

const MAX_FILE_BYTES = 512 * 1024;
const CURRENT = "diagnostics.log";
const PREVIOUS = "diagnostics.1.log";

export class DiagnosticsRecorder {
  private queue: Promise<void> = Promise.resolve();
  private bytes = 0;
  private started = false;

  constructor(
    private readonly directory: string,
    private readonly identity: DiagnosticBuildIdentity,
  ) {}

  private get currentPath(): string {
    return path.join(this.directory, CURRENT);
  }

  private get previousPath(): string {
    return path.join(this.directory, PREVIOUS);
  }

  /**
   * Queue one event.
   *
   * Deliberately returns void rather than a promise: no caller should be able
   * to await diagnostics, because a caller that awaited would be able to be
   * delayed by them. Ordering is still guaranteed by the queue.
   */
  record(event: Omit<DiagnosticEvent, "at"> & { at?: number }): void {
    const line = formatDiagnosticLine({ ...event, at: event.at ?? Date.now() });
    this.enqueue(async () => {
      // The allowlist already dropped anything unexpected; this asserts the
      // rendered bytes, which is what actually reaches disk.
      assertRedacted(line);
      await this.ensureStarted();
      await this.rotateIfNeeded(line.length);
      await appendFile(this.currentPath, line, { mode: 0o600 });
      this.bytes += line.length;
    });
  }

  /** Everything queued so far has reached disk. Used by shutdown and by tests. */
  async flush(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  /**
   * The redacted trail, newest file last, for "Copy diagnostics".
   *
   * Reads through the same rotation the writer uses, and re-asserts redaction
   * on the way out: a file that predates a redaction fix must not be handed to
   * the clipboard just because it is already on disk.
   */
  async read(): Promise<string> {
    await this.flush();
    const parts: string[] = [];
    for (const candidate of [this.previousPath, this.currentPath]) {
      try {
        parts.push(await readFile(candidate, "utf8"));
      } catch {
        // A missing rotation file simply contributes nothing.
      }
    }
    const content = parts.join("");
    try {
      assertRedacted(content);
    } catch {
      return "LocalScribe withheld the diagnostics file because it failed its own redaction check.\n";
    }
    return content;
  }

  /** Removes the trail entirely. */
  async clear(): Promise<void> {
    this.enqueue(async () => {
      await rm(this.currentPath, { force: true });
      await rm(this.previousPath, { force: true });
      this.bytes = 0;
      this.started = false;
    });
    await this.flush();
  }

  private enqueue(operation: () => Promise<void>): void {
    this.queue = this.queue.then(operation).catch(() => {
      // Diagnostics must never surface as an application failure. A recorder
      // that cannot write (full disk, revoked permission) degrades to silence.
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.started) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      this.bytes = (await stat(this.currentPath)).size;
    } catch {
      this.bytes = 0;
    }
    // Each run stamps its own build identity, so a trail that spans an update
    // says which build produced which lines — the exact question that could not
    // be answered when a running app was overwritten by a new build.
    const header = formatDiagnosticHeader(this.identity);
    assertRedacted(header);
    await appendFile(this.currentPath, header, { mode: 0o600 });
    this.bytes += header.length;
    this.started = true;
  }

  private async rotateIfNeeded(incoming: number): Promise<void> {
    if (this.bytes + incoming <= MAX_FILE_BYTES) return;
    await rm(this.previousPath, { force: true });
    await rename(this.currentPath, this.previousPath);
    this.bytes = 0;
    const header = formatDiagnosticHeader(this.identity);
    await appendFile(this.currentPath, header, { mode: 0o600 });
    this.bytes += header.length;
  }
}

/**
 * A recorder that drops everything.
 *
 * Lets the session path call `diagnostics.record(...)` unconditionally instead
 * of guarding every call site with a null check — a guard that would eventually
 * be forgotten at the one call site that mattered.
 */
export const nullDiagnosticsRecorder = {
  record(): void {},
  async flush(): Promise<void> {},
  async read(): Promise<string> {
    return "";
  },
  async clear(): Promise<void> {},
};

export type DiagnosticsSink = Pick<DiagnosticsRecorder, "record" | "flush" | "read" | "clear">;
