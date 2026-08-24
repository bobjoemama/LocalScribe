import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import {
  assertRedacted,
  formatDiagnosticHeader,
  formatDiagnosticLine,
  type DiagnosticBuildIdentity,
  type DiagnosticEvent,
} from "../../shared/diagnosticsLog";

const MAX_FILE_BYTES = 512 * 1024;
const CURRENT = "diagnostics.log";
const PREVIOUS = "diagnostics.1.log";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

function entryError(entryPath: string, expected: "directory" | "regular file"): Error {
  return new Error(`Unsafe diagnostics entry ${path.basename(entryPath)}: expected ${expected}`);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function lstatIfPresent(entryPath: string): Promise<Stats | null> {
  try {
    return await lstat(entryPath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/**
 * Bounded, rotating, privacy-checked failure trail.
 *
 * Recording is deliberately best-effort. Explicit management operations are
 * different: clear() rejects if the trail could not actually be removed, so
 * Settings can report the truth instead of claiming data was cleared.
 */
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

  record(event: Omit<DiagnosticEvent, "at"> & { at?: number }): void {
    const line = formatDiagnosticLine({ ...event, at: event.at ?? Date.now() });
    this.enqueueBestEffort(async () => {
      assertRedacted(line);
      await this.ensureStarted();
      await this.rotateIfNeeded(Buffer.byteLength(line));
      await this.appendSecure(this.currentPath, line);
      this.bytes += Buffer.byteLength(line);
    });
  }

  /** Everything queued so far has either reached disk or safely degraded. */
  async flush(): Promise<void> {
    await this.queue;
  }

  async read(): Promise<string> {
    await this.flush();
    try {
      const directory = await this.openDirectory(false);
      if (directory === null) return "";
      const parts: string[] = [];
      try {
        for (const candidate of [this.previousPath, this.currentPath]) {
          const content = await this.readSecure(candidate, directory);
          if (content !== null) parts.push(content);
        }
        await this.assertDirectoryStillMatches(directory);
      } finally {
        await directory.close();
      }
      const content = parts.join("");
      assertRedacted(content);
      return content;
    } catch {
      return "LocalScribe withheld the diagnostics file because it failed its safety check.\n";
    }
  }

  /** Clears every trail byte, rejecting if any verified descriptor cannot be truncated. */
  async clear(): Promise<void> {
    const operation = this.queue.then(async () => {
      const directory = await this.openDirectory(false);
      if (directory !== null) {
        const handles: FileHandle[] = [];
        try {
          for (const candidate of [this.currentPath, this.previousPath]) {
            const handle = await this.openRegularFile(
              candidate,
              constants.O_RDWR,
              false,
              directory,
            );
            if (handle !== null) handles.push(handle);
          }
          await this.assertDirectoryStillMatches(directory);
          // Truncate only already-verified descriptors. Node does not expose
          // openat/unlinkat; descriptor truncation therefore avoids ever
          // deleting through a swapped parent-directory symlink.
          for (const handle of handles) {
            await handle.truncate(0);
            await handle.sync();
          }
          await this.assertDirectoryStillMatches(directory);
        } finally {
          await Promise.allSettled(handles.map((handle) => handle.close()));
          await directory.close();
        }
      }
      this.bytes = 0;
      this.started = false;
    });
    // Keep later best-effort records usable even when the explicit clear
    // operation rejects, while returning the real failure to this caller.
    this.queue = operation.catch(() => undefined);
    await operation;
  }

  private enqueueBestEffort(operation: () => Promise<void>): void {
    this.queue = this.queue.then(operation).catch(() => {
      // A full disk, revoked permission, or unsafe filesystem entry must not
      // change the outcome of dictation.
    });
  }

  private async openDirectory(create: boolean): Promise<FileHandle | null> {
    if (create) await mkdir(this.directory, { recursive: true, mode: DIRECTORY_MODE });
    const pathInfo = await lstatIfPresent(this.directory);
    if (pathInfo === null) return null;
    if (pathInfo.isSymbolicLink() || !pathInfo.isDirectory()) {
      throw entryError(this.directory, "directory");
    }
    let handle: FileHandle;
    try {
      handle = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw entryError(this.directory, "directory");
      }
      throw error;
    }
    try {
      const descriptorInfo = await handle.stat();
      if (
        !descriptorInfo.isDirectory()
        || descriptorInfo.dev !== pathInfo.dev
        || descriptorInfo.ino !== pathInfo.ino
      ) {
        throw entryError(this.directory, "directory");
      }
      await handle.chmod(DIRECTORY_MODE);
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private async openRegularFile(
    filePath: string,
    flags: number,
    create: boolean,
    directory?: FileHandle,
  ): Promise<FileHandle | null> {
    if (directory !== undefined) await this.assertDirectoryStillMatches(directory);
    const pathInfo = await lstatIfPresent(filePath);
    if (pathInfo !== null && (pathInfo.isSymbolicLink() || !pathInfo.isFile())) {
      throw entryError(filePath, "regular file");
    }
    if (pathInfo === null && !create) return null;

    let handle: FileHandle;
    try {
      handle = await open(
        filePath,
        flags | constants.O_NOFOLLOW | constants.O_NONBLOCK | (create ? constants.O_CREAT : 0),
        FILE_MODE,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw entryError(filePath, "regular file");
      }
      throw error;
    }
    try {
      const descriptorInfo = await handle.stat();
      if (
        !descriptorInfo.isFile()
        || (pathInfo !== null && (
          descriptorInfo.dev !== pathInfo.dev
          || descriptorInfo.ino !== pathInfo.ino
        ))
      ) {
        throw entryError(filePath, "regular file");
      }
      if (directory !== undefined) await this.assertDirectoryStillMatches(directory);
      await handle.chmod(FILE_MODE);
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private async appendSecure(
    filePath: string,
    content: string,
    retainedDirectory?: FileHandle,
  ): Promise<number> {
    const directory = retainedDirectory ?? await this.openDirectory(true);
    if (directory === null) throw entryError(this.directory, "directory");
    try {
      const handle = await this.openRegularFile(
        filePath,
        constants.O_WRONLY | constants.O_APPEND,
        true,
        directory,
      );
      if (handle === null) throw entryError(filePath, "regular file");
      try {
        const before = (await handle.stat()).size;
        await handle.writeFile(content);
        await this.assertDirectoryStillMatches(directory);
        return before;
      } finally {
        await handle.close();
      }
    } finally {
      if (retainedDirectory === undefined) await directory.close();
    }
  }

  private async readSecure(filePath: string, directory: FileHandle): Promise<string | null> {
    const handle = await this.openRegularFile(filePath, constants.O_RDONLY, false, directory);
    if (handle === null) return null;
    try {
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }

  private async assertDirectoryStillMatches(handle: FileHandle): Promise<void> {
    /*
     * Node does not expose openat(2), so pathname opens cannot be made fully
     * descriptor-relative here. Retaining the verified directory descriptor
     * and comparing its device/inode before and after each file open closes
     * ordinary replacement races and all cross-account attacks (the directory
     * is 0700). A malicious process already running as this same account could
     * theoretically swap the path away and back between those checks; clear()
     * still truncates only the verified file descriptors and never path-unlinks,
     * so that residual race cannot delete or truncate a substituted target.
     */
    const [descriptorInfo, pathInfo] = await Promise.all([
      handle.stat(),
      lstatIfPresent(this.directory),
    ]);
    if (
      pathInfo === null
      || pathInfo.isSymbolicLink()
      || !pathInfo.isDirectory()
      || descriptorInfo.dev !== pathInfo.dev
      || descriptorInfo.ino !== pathInfo.ino
    ) {
      throw entryError(this.directory, "directory");
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.started) return;
    const directory = await this.openDirectory(true);
    if (directory === null) throw entryError(this.directory, "directory");
    try {
      const header = formatDiagnosticHeader(this.identity);
      assertRedacted(header);
      this.bytes = await this.appendSecure(this.currentPath, header, directory);
      this.bytes += Buffer.byteLength(header);
      this.started = true;
    } finally {
      await directory.close();
    }
  }

  private async rotateIfNeeded(incoming: number): Promise<void> {
    if (this.bytes + incoming <= MAX_FILE_BYTES) return;
    const directory = await this.openDirectory(false);
    if (directory === null) throw entryError(this.directory, "directory");
    const handles: FileHandle[] = [];
    try {
      const current = await this.openRegularFile(
        this.currentPath,
        constants.O_RDWR,
        false,
        directory,
      );
      if (current === null) throw entryError(this.currentPath, "regular file");
      handles.push(current);
      const previous = await this.openRegularFile(
        this.previousPath,
        constants.O_RDWR,
        true,
        directory,
      );
      if (previous === null) throw entryError(this.previousPath, "regular file");
      handles.push(previous);

      const priorTrail = await current.readFile("utf8");
      assertRedacted(priorTrail);
      const priorBytes = Buffer.from(priorTrail);
      const header = formatDiagnosticHeader(this.identity);
      assertRedacted(header);
      const headerBytes = Buffer.from(header);
      await this.assertDirectoryStillMatches(directory);

      // Rotate through already-verified descriptors. This deliberately avoids
      // rm/rename path operations, so a parent-directory swap cannot redirect
      // deletion or replacement into another directory.
      await previous.truncate(0);
      if (priorBytes.length > 0) {
        await previous.write(priorBytes, 0, priorBytes.length, 0);
      }
      await previous.sync();
      await current.truncate(0);
      await current.write(headerBytes, 0, headerBytes.length, 0);
      await current.sync();
      await this.assertDirectoryStillMatches(directory);
      this.bytes = headerBytes.length;
    } finally {
      await Promise.allSettled(handles.map((handle) => handle.close()));
      await directory.close();
    }
  }
}

export const nullDiagnosticsRecorder = {
  record(): void {},
  async flush(): Promise<void> {},
  async read(): Promise<string> {
    return "";
  },
  async clear(): Promise<void> {},
};

export type DiagnosticsSink = Pick<DiagnosticsRecorder, "record" | "flush" | "read" | "clear">;
