import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preflightMacApplicationZip } from "../scripts/macos-zip-preflight.mts";

const temporaryRoots: string[] = [];

function archiveFixture(configure: (application: string) => void): string {
  const root = mkdtempSync(path.join(tmpdir(), "localscribe-zip-preflight-"));
  temporaryRoots.push(root);
  const application = path.join(root, "LocalScribe.app");
  mkdirSync(path.join(application, "Contents", "Frameworks", "Example.framework", "Versions", "A"), {
    recursive: true,
  });
  const executable = path.join(application, "Contents", "MacOS", "LocalScribe");
  mkdirSync(path.dirname(executable), { recursive: true });
  writeFileSync(executable, "fixture");
  chmodSync(executable, 0o755);
  configure(application);
  const archive = path.join(root, "candidate.zip");
  execFileSync("ditto", ["-c", "-k", "--keepParent", application, archive]);
  return archive;
}

function archiveWithFileParent(): string {
  const root = mkdtempSync(path.join(tmpdir(), "localscribe-zip-preflight-"));
  temporaryRoots.push(root);
  const archive = path.join(root, "candidate.zip");
  const program = [
    "import stat, sys, zipfile",
    "with zipfile.ZipFile(sys.argv[1], 'w') as archive:",
    "  for name, mode, content in [",
    "    ('LocalScribe.app/', stat.S_IFDIR | 0o755, b''),",
    "    ('LocalScribe.app/Contents', stat.S_IFREG | 0o644, b'file'),",
    "    ('LocalScribe.app/Contents/child', stat.S_IFREG | 0o644, b'child'),",
    "  ]:",
    "    entry = zipfile.ZipInfo(name)",
    "    entry.create_system = 3",
    "    entry.external_attr = mode << 16",
    "    archive.writestr(entry, content)",
  ].join("\n");
  execFileSync("python3", ["-B", "-c", program, archive]);
  return archive;
}

function archiveWithSymlinkParent(): string {
  const root = mkdtempSync(path.join(tmpdir(), "localscribe-zip-preflight-"));
  temporaryRoots.push(root);
  const archive = path.join(root, "candidate.zip");
  const program = [
    "import stat, sys, zipfile",
    "with zipfile.ZipFile(sys.argv[1], 'w') as archive:",
    "  for name, mode, content in [",
    "    ('LocalScribe.app/', stat.S_IFDIR | 0o755, b''),",
    "    ('LocalScribe.app/Contents/', stat.S_IFDIR | 0o755, b''),",
    "    ('LocalScribe.app/Contents/target/', stat.S_IFDIR | 0o755, b''),",
    "    ('LocalScribe.app/Contents/link', stat.S_IFLNK | 0o755, b'target'),",
    "    ('LocalScribe.app/Contents/link/child', stat.S_IFREG | 0o644, b'child'),",
    "  ]:",
    "    entry = zipfile.ZipInfo(name)",
    "    entry.create_system = 3",
    "    entry.external_attr = mode << 16",
    "    archive.writestr(entry, content)",
  ].join("\n");
  execFileSync("python3", ["-B", "-c", program, archive]);
  return archive;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe.runIf(process.platform === "darwin")("macOS application ZIP preflight", () => {
  it("accepts the nested relative symlink chain used by macOS frameworks", async () => {
    const archive = archiveFixture((application) => {
      const framework = path.join(
        application,
        "Contents",
        "Frameworks",
        "Example.framework",
      );
      const frameworkExecutable = path.join(framework, "Versions", "A", "Example");
      writeFileSync(frameworkExecutable, "framework fixture");
      chmodSync(frameworkExecutable, 0o755);
      symlinkSync("A", path.join(framework, "Versions", "Current"));
      symlinkSync("Versions/Current/Example", path.join(framework, "Example"));
    });

    await expect(preflightMacApplicationZip(archive, "LocalScribe.app")).resolves.toBeUndefined();
  });

  it("rejects a bundle symlink that would escape during extraction", async () => {
    const archive = archiveFixture((application) => {
      symlinkSync("../../../outside", path.join(application, "Contents", "escape"));
    });

    await expect(preflightMacApplicationZip(archive, "LocalScribe.app")).rejects.toThrow(
      /escapes the application bundle/u,
    );
  });

  it("rejects an escape reached through a relative symlink chain", async () => {
    const archive = archiveFixture((application) => {
      const contents = path.join(application, "Contents");
      symlinkSync("escape-link", path.join(contents, "first-link"));
      symlinkSync("../../../outside", path.join(contents, "escape-link"));
    });

    await expect(preflightMacApplicationZip(archive, "LocalScribe.app")).rejects.toThrow(
      /escapes the application bundle/u,
    );
  });

  it("rejects a symlink cycle", async () => {
    const archive = archiveFixture((application) => {
      const contents = path.join(application, "Contents");
      symlinkSync("second-link", path.join(contents, "first-link"));
      symlinkSync("first-link", path.join(contents, "second-link"));
    });

    await expect(preflightMacApplicationZip(archive, "LocalScribe.app")).rejects.toThrow(
      /symlink cycle/u,
    );
  });

  it("rejects a symlink chain whose resolved endpoint is missing", async () => {
    const archive = archiveFixture((application) => {
      const framework = path.join(
        application,
        "Contents",
        "Frameworks",
        "Example.framework",
      );
      symlinkSync("A", path.join(framework, "Versions", "Current"));
      symlinkSync("Versions/Current/Missing", path.join(framework, "Example"));
    });

    await expect(preflightMacApplicationZip(archive, "LocalScribe.app")).rejects.toThrow(
      /points to a missing archive entry/u,
    );
  });

  it("rejects an absolute symlink target", async () => {
    const archive = archiveFixture((application) => {
      symlinkSync("/tmp/outside", path.join(application, "Contents", "absolute-link"));
    });

    await expect(preflightMacApplicationZip(archive, "LocalScribe.app")).rejects.toThrow(
      /invalid symlink target/u,
    );
  });

  it("rejects group- or world-writable archive entries", async () => {
    const archive = archiveFixture((application) => {
      const unsafe = path.join(application, "Contents", "unsafe.txt");
      writeFileSync(unsafe, "unsafe");
      chmodSync(unsafe, 0o666);
    });

    await expect(preflightMacApplicationZip(archive, "LocalScribe.app")).rejects.toThrow(
      /unsafe Unix permissions/u,
    );
  });

  it("rejects a child nested beneath an archive file before extraction", async () => {
    await expect(
      preflightMacApplicationZip(archiveWithFileParent(), "LocalScribe.app"),
    ).rejects.toThrow(/nested beneath a non-directory/u);
  });

  it("rejects an archived child nested beneath a symlink", async () => {
    await expect(
      preflightMacApplicationZip(archiveWithSymlinkParent(), "LocalScribe.app"),
    ).rejects.toThrow(/nested beneath a non-directory/u);
  });
});
