import {
  chmodSync, existsSync, mkdtempSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MacControlMonitor, type ControlMonitorEvent } from "../src/main/hotkeys/macControlMonitor";
import { proveRegularExecutable } from "../src/main/insertion/nativeExecutableIntegrity";

function ownedFixture(): { directory: string; helper: string; source: string } {
  const directory = mkdtempSync(path.join(os.tmpdir(), "localscribe-owned-monitor-"));
  const helper = path.join(directory, "helper");
  // This executable emits a fixed protocol event; it never registers a global
  // monitor or consults actual key state, Accessibility, focus, or clipboard.
  const source = `#!${process.execPath}
if (process.argv[2] !== 'hold-monitor') process.exit(2);
require('node:fs').writeFileSync(__filename + '.started', 'started');
console.log(JSON.stringify({ event: 'hold-down' }));
`;
  writeFileSync(helper, source, { mode: 0o700 });
  return { directory, helper, source };
}

describe("hold monitor executable metadata revalidation", () => {
  it("starts an owned executable after ctime-only drift and receives its protocol event", async () => {
    const { directory, helper } = ownedFixture();
    const monitor = new MacControlMonitor(helper);
    try {
      const before = proveRegularExecutable(helper);
      await new Promise((resolve) => setTimeout(resolve, 10));
      chmodSync(helper, 0o700);
      const after = proveRegularExecutable(helper);
      expect(before).not.toBeNull();
      expect(after).not.toBeNull();
      expect(after?.changedAtMs).not.toBe(before?.changedAtMs);
      expect(after).toEqual({ ...before, changedAtMs: after?.changedAtMs });

      const received: ControlMonitorEvent[] = [];
      let resolveStopped!: () => void;
      const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
      expect(monitor.start("Control+Space", (event) => received.push(event), resolveStopped))
        .toBe(true);
      await stopped;
      expect(received).toEqual(["hold-down"]);
      expect(existsSync(`${helper}.started`)).toBe(true);
    } finally {
      monitor.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["bytes", "inode", "permissions"] as const)(
    "refuses changed %s before spawning the owned executable",
    (change) => {
      const { directory, helper, source } = ownedFixture();
      const monitor = new MacControlMonitor(helper);
      try {
        if (change === "bytes") writeFileSync(helper, `${source}\n// changed bytes\n`);
        if (change === "permissions") chmodSync(helper, 0o711);
        if (change === "inode") {
          const replacement = path.join(directory, "replacement");
          writeFileSync(replacement, source, { mode: 0o700 });
          renameSync(replacement, helper);
        }
        expect(monitor.start("Control+Space", () => {})).toBe(false);
        expect(existsSync(`${helper}.started`)).toBe(false);
      } finally {
        monitor.stop();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
