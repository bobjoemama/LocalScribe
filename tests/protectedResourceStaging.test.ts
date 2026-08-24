import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { promoteProtectedResources } from "../scripts/protected-resource-staging.mts";

const sha256 = (filePath: string): string =>
  createHash("sha256").update(readFileSync(filePath)).digest("hex");

describe("protected package resource staging", () => {
  it("restores tracked recovery inputs byte-for-byte and mode-for-mode", () => {
    const root = mkdtempSync(path.join(tmpdir(), "localscribe-protected-stage-"));
    try {
      const source = path.join(root, "tracked-helper");
      const staged = path.join(root, "built-helper");
      writeFileSync(source, "tracked recovery bytes");
      writeFileSync(staged, "fresh package bytes");
      chmodSync(source, 0o744);
      chmodSync(staged, 0o755);
      const before = sha256(source);

      const preparation = promoteProtectedResources([{ sourcePath: source, stagedPath: staged }]);
      expect(readFileSync(source, "utf8")).toBe("fresh package bytes");
      expect(statSync(source).mode & 0o777).toBe(0o755);

      preparation.restore();
      preparation.restore();
      expect(sha256(source)).toBe(before);
      expect(readFileSync(source, "utf8")).toBe("tracked recovery bytes");
      expect(statSync(source).mode & 0o777).toBe(0o744);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("supports a clean checkout where the ignored compiled helper is absent", () => {
    const root = mkdtempSync(path.join(tmpdir(), "localscribe-protected-stage-"));
    try {
      const source = path.join(root, "ignored-active-target");
      const staged = path.join(root, "built-active-target");
      writeFileSync(staged, "fresh compiled helper");
      chmodSync(staged, 0o755);
      expect(existsSync(source)).toBe(false);

      const preparation = promoteProtectedResources([{ sourcePath: source, stagedPath: staged }]);
      expect(readFileSync(source, "utf8")).toBe("fresh compiled helper");
      preparation.restore();

      expect(existsSync(source)).toBe(false);
      expect(readFileSync(staged, "utf8")).toBe("fresh compiled helper");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
