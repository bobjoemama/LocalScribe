import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writePrivateFile } from "../src/main/persistence/privateFile";
import { sliceBetween } from "./support/order";

/*
 * A history export is every transcript the user has ever dictated, decrypted,
 * in one file they chose the location of. The permissions on that file are the
 * only thing standing between it and every other account on the machine.
 *
 * These run against the real filesystem on purpose. The defect being pinned —
 * `writeFile(..., { mode })` applying the mode only when the open creates the
 * file — is invisible to any test that mocks `fs`, because the mock is what
 * would have to reproduce it.
 */

const directories: string[] = [];

function workspace(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "localscribe-private-file-"));
  directories.push(directory);
  return directory;
}

async function modeOf(filePath: string): Promise<string> {
  return ((await stat(filePath)).mode & 0o777).toString(8);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("writing a file only this account can read", () => {
  it("creates a new file readable by nobody else", async () => {
    const target = path.join(workspace(), "history.json");

    await writePrivateFile(target, '{"transcriptions":[]}\n');

    expect(await modeOf(target)).toBe("600");
  });

  it("tightens a world-readable file it is overwriting", async () => {
    /*
     * The reported defect, reproduced: exporting a second time to the same
     * name, or over anything another tool created, left the old permissions in
     * place while filling the file with decrypted transcripts.
     */
    const target = path.join(workspace(), "history.json");
    writeFileSync(target, "stale export\n");
    chmodSync(target, 0o644);
    expect(await modeOf(target)).toBe("644");

    await writePrivateFile(target, '{"transcriptions":["secret"]}\n');

    expect(await modeOf(target)).toBe("600");
  });

  it("tightens a group- or world-writable file too", async () => {
    const target = path.join(workspace(), "history.json");
    writeFileSync(target, "x");
    chmodSync(target, 0o666);

    await writePrivateFile(target, "y");

    expect(await modeOf(target)).toBe("600");
  });

  it("replaces the previous contents rather than appending to them", async () => {
    const target = path.join(workspace(), "history.json");
    writeFileSync(target, "a much longer previous export that must not survive\n");

    await writePrivateFile(target, "short\n");

    expect(readFileSync(target, "utf8")).toBe("short\n");
  });

  it("writes exactly the bytes it was given", async () => {
    const target = path.join(workspace(), "history.json");
    const payload = `${JSON.stringify({ transcriptions: ["héllo — wörld"] }, null, 2)}\n`;

    await writePrivateFile(target, payload);

    expect(readFileSync(target, "utf8")).toBe(payload);
  });

  it("atomically replaces the destination inode", async () => {
    const target = path.join(workspace(), "history.json");
    writeFileSync(target, "old\n");
    const previousInode = statSync(target).ino;

    await writePrivateFile(target, "new\n");

    expect(readFileSync(target, "utf8")).toBe("new\n");
    expect(statSync(target).ino).not.toBe(previousInode);
  });

  it("rejects a symlink target without changing its referent", async () => {
    const directory = workspace();
    const outside = path.join(directory, "outside.json");
    const target = path.join(directory, "history.json");
    writeFileSync(outside, "keep me\n");
    symlinkSync(outside, target);

    await expect(writePrivateFile(target, "secret\n")).rejects.toThrow(/unsafe private-file target/u);
    expect(readFileSync(outside, "utf8")).toBe("keep me\n");
  });

  it("rejects a non-regular target", async () => {
    const target = path.join(workspace(), "history.json");
    mkdirSync(target);

    await expect(writePrivateFile(target, "secret\n")).rejects.toThrow(/unsafe private-file target/u);
  });

  it("preserves the prior export and removes its temp after a pre-rename failure", async () => {
    const directory = workspace();
    // The destination name is legal, while adding the private temp suffix
    // exceeds NAME_MAX and makes temp creation fail deterministically.
    const target = path.join(directory, `${"a".repeat(220)}.json`);
    writeFileSync(target, "previous export\n");

    await expect(writePrivateFile(target, "replacement\n")).rejects.toThrow();

    expect(readFileSync(target, "utf8")).toBe("previous export\n");
    expect(readdirSync(directory)).toEqual([path.basename(target)]);
  });

  /*
   * The ordering that makes the fix a fix rather than a tidy-up: if the content
   * were written first and the permissions changed afterwards, there would be a
   * window in which the full plaintext existed at 0644. Verified by observing
   * the file's mode from inside the write.
   */
  it("never holds the content under the old permissions, not even briefly", async () => {
    const target = path.join(workspace(), "history.json");
    writeFileSync(target, "");
    chmodSync(target, 0o644);
    const observed: Array<{ mode: string; size: number }> = [];

    // A large payload so the write cannot complete in one uninterrupted step,
    // sampled from a timer that runs between the awaits inside the helper.
    const sampler = setInterval(() => {
      try {
        const info = statSync(target);
        observed.push({ mode: (info.mode & 0o777).toString(8), size: info.size });
      } catch {
        // The file is only missing if something else removed it; nothing to
        // record either way.
      }
    }, 0);
    await writePrivateFile(target, "x".repeat(4 * 1024 * 1024));
    clearInterval(sampler);

    const leaked = observed.filter((sample) => sample.mode !== "600" && sample.size > 0);
    expect(leaked, `content was visible at ${leaked[0]?.mode ?? "?"}`).toEqual([]);
  });

  it("closes every descriptor it opens", async () => {
    /*
     * One leaked descriptor per export is a slow leak in an app that runs for
     * weeks. Counted from /dev/fd rather than asserted from the source, and
     * across repeated writes, because a single leak is indistinguishable from
     * ordinary variation.
     *
     * Deliberately not driven through a failed write: `open` on a directory
     * rejects before any descriptor exists, so that path has nothing to leak
     * and proves nothing about the `finally`.
     */
    const directory = workspace();
    const openDescriptors = () => readdirSync("/dev/fd").length;

    // Warm up first: the first write can pull in lazily-loaded internals.
    await writePrivateFile(path.join(directory, "warm.json"), "x");
    const before = openDescriptors();
    for (let index = 0; index < 40; index += 1) {
      await writePrivateFile(path.join(directory, `export-${index}.json`), "x");
    }

    expect(openDescriptors() - before).toBeLessThan(5);
  });

  it("propagates a failure instead of reporting a file that was never written", async () => {
    const missing = path.join(workspace(), "no-such-directory", "history.json");

    await expect(writePrivateFile(missing, "x")).rejects.toThrow(/ENOENT/u);
  });

  it("is what the history export actually calls", () => {
    // The behaviour above is worth nothing if the export still writes its own
    // file. Narrow on purpose: only that the one plaintext-bearing write is
    // routed here.
    const main = readFileSync("src/main.ts", "utf8");
    const exportHandler = sliceBetween(
      main,
      "const exported = database.exportTranscriptionsWithIntegrity();",
      "return result.filePath;",
      "src/main.ts",
    );

    expect(exportHandler).toContain("writePrivateFile(result.filePath");
    expect(exportHandler).not.toContain("writeFile(result.filePath");
  });
});
