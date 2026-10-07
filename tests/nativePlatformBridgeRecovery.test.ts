import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ clipboard: {}, nativeImage: {} }));

import { InsertionService } from "../src/main/insertion/insertionService";
import { NativeExecutableInsertionBridge } from "../src/main/insertion/nativePlatformBridge";
import { proveRegularExecutable } from "../src/main/insertion/nativeExecutableIntegrity";

describe("real executable readiness recovery", () => {
  it("recovers status metadata and transient spawn failure while refusing replacement", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "localscribe-owned-helper-"));
    try {
      const helper = path.join(directory, "helper");
      const statePath = `${helper}.json`;
      const source = `#!${process.execPath}
const { readFileSync } = require('node:fs');
const state = JSON.parse(readFileSync(__filename + '.json', 'utf8'));
if (state.fail) process.exit(1);
if (process.argv[2] === 'self-test') {
  console.log(JSON.stringify({ platform: 'darwin', selfTest: true }));
} else if (process.argv[2] === 'accessibility-status') {
  console.log(JSON.stringify({ accessibility: state.granted, postEvents: state.granted }));
} else process.exit(2);
`;
      writeFileSync(helper, source, { mode: 0o700 });
      writeFileSync(statePath, JSON.stringify({ fail: true, granted: true }));
      const bridge = new NativeExecutableInsertionBridge(helper);
      const insertion = new InsertionService({
        platformBridge: bridge,
        platform: "darwin",
        clipboard: {
          snapshot: () => ({ restorable: true }), writeText: () => {}, restore: () => {},
        },
      });

      // Both protocol and status commands cross the actual execFile boundary.
      await expect(insertion.automaticPasteReady()).resolves.toBe(false);
      await expect(insertion.accessibilityStatus()).resolves.toBe("unavailable");
      writeFileSync(statePath, JSON.stringify({ fail: false, granted: true }));
      await expect(insertion.automaticPasteReady()).resolves.toBe(true);

      const before = proveRegularExecutable(helper);
      await new Promise((resolve) => setTimeout(resolve, 10));
      chmodSync(helper, 0o700);
      const after = proveRegularExecutable(helper);
      expect(before).not.toBeNull();
      expect(after).not.toBeNull();
      expect(after?.changedAtMs).not.toBe(before?.changedAtMs);
      expect(after).toEqual({ ...before, changedAtMs: after?.changedAtMs });
      await expect(insertion.automaticPasteReady()).resolves.toBe(true);

      writeFileSync(statePath, JSON.stringify({ fail: false, granted: false }));
      await expect(insertion.accessibilityStatus()).resolves.toBe("denied");
      await expect(insertion.automaticPasteReady()).resolves.toBe(false);
      writeFileSync(statePath, JSON.stringify({ fail: false, granted: true }));
      await expect(insertion.automaticPasteReady()).resolves.toBe(true);

      const replacement = path.join(directory, "replacement");
      writeFileSync(replacement, source, { mode: 0o700 });
      renameSync(replacement, helper);
      await expect(insertion.accessibilityStatus()).resolves.toBe("unavailable");
      await expect(insertion.automaticPasteReady()).resolves.toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
